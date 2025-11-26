#include <Arduino.h>
#include <Wire.h>
#include <WiFi.h>
#include <ESPAsyncWebServer.h>
#include <SPIFFS.h>
#include <MPU6050_light.h>
#include <math.h>

// ----------------------- CONFIG -----------------------
const char *AP_SSID = "TremorDevice";
const char *AP_PASS = "12345678";

AsyncWebServer server(80);
AsyncEventSource events("/events");

MPU6050 mpu(Wire);

// Sampling
const double SAMPLE_RATE = 50.0;
const uint16_t WINDOW = 128;

// Filters
const uint8_t MA_LEN = 20;

// Button & LED
const int BUTTON_PIN = 16;
const int LED_PIN = 2;

// Button logic
unsigned long lastDebounce = 0;
unsigned long pressStart = 0;
bool lastState = HIGH;
bool stableState = HIGH;
const unsigned long DEBOUNCE_MS = 50;
const unsigned long LONG_PRESS_MS = 2000;

// States
bool streaming = false;
bool calibrationMode = false;
unsigned long calibStart = 0;
double calibSum = 0.0;
unsigned long calibCount = 0;
const unsigned long CALIB_DURATION = 5000;

// LED blink
unsigned long lastBlink = 0;
bool ledState = false;
const unsigned long BLINK_MS = 300;

// ----------------------- DSP Buffers -----------------------
double windowBuf[WINDOW];
uint16_t winIdx = 0;

float maAx[MA_LEN], maAy[MA_LEN], maAz[MA_LEN], maNorm[MA_LEN];
float sumAx=0,sumAy=0,sumAz=0,sumNorm=0;
uint8_t maIdx=0;
bool maFilled=false;

float ma_get(float s){ return s / MA_LEN; }

// High-pass filter
struct Biquad {
  double a1,a2,b0,b1,b2;
  double x1=0,x2=0,y1=0,y2=0;
  void initHPF(double fs,double fc,double Q=0.707){
    double w0=2*M_PI*fc/fs;
    double c=cos(w0), s=sin(w0);
    double alpha=s/(2*Q);

    double b0n=(1+c)/2;
    double b1n=-(1+c);
    double b2n=(1+c)/2;
    double a0n=1+alpha;
    double a1n=-2*c;
    double a2n=1-alpha;

    b0=b0n/a0n; b1=b1n/a0n; b2=b2n/a0n;
    a1=a1n/a0n; a2=a2n/a0n;
  }
  double process(double x){
    double y=b0*x + b1*x1 + b2*x2 - a1*y1 - a2*y2;
    x2=x1; x1=x; y2=y1; y1=y;
    return y;
  }
};

Biquad hpfX,hpfY,hpfZ;

// ----------------------- Goertzel Bands -----------------------
double goertzel(const double *data,uint16_t N,double f,double fs){
  double w=2*M_PI*f/fs;
  double c=2*cos(w);
  double s0=0,s1=0,s2=0;
  for(int i=0;i<N;i++){
    s0=data[i] + c*s1 - s2;
    s2=s1;
    s1=s0;
  }
  return s1*s1 + s2*s2 - c*s1*s2;
}

const double band1[]={4,5,6};
const double band2[]={6,7,8};
const double band3[]={8,10,12};

double NOISE_FLOOR=0.01;
double BASE_FOR_SCORE=0.01;
double SCORE_SCALE=3.0;
double MAX_POWER=25.0;

// ----------------------- SSE helpers -----------------------
void sendSample(float ax,float ay,float az){
  static int limiter=0; limiter++;
  if(limiter<2) return;
  limiter=0;
  char m[120];
  sprintf(m,"{\"ax\":%.4f,\"ay\":%.4f,\"az\":%.4f}",ax,ay,az);
  events.send(m,"sample");
}

// Spectrogram
void sendBandsCSV(double P1,double P2,double P3,double mean){
  char m[128];
  sprintf(m,"%.6f,%.6f,%.6f,%.4f",P1,P2,P3,mean);
  events.send(m,"bands_csv");
}

// Classification SSE
void sendBandsSSE(double P1,double P2,double P3,const char *type,double conf,double score,double meanNorm){
  char m[256];
  sprintf(m,
  "{\"b1\":%.6f,\"b2\":%.6f,\"b3\":%.6f,"
  "\"type\":\"%s\",\"confidence\":%.3f,"
  "\"score\":%.3f,\"meanNorm\":%.4f}",
  P1,P2,P3,type,conf,score,meanNorm);
  events.send(m,"bands");
}

// Calibration SSE
void sendCalibrated(double baseline){
  char m[128];
  sprintf(m,"{\"baseline\":%.6f}",baseline);
  events.send(m,"calibrated");
}

// ----------------------- Classification -----------------------
void classify(double P1,double P2,double P3,double meanNorm){
  double A1=P1>NOISE_FLOOR?P1:0;
  double A2=P2>NOISE_FLOOR?P2:0;
  double A3=P3>NOISE_FLOOR?P3:0;

  double total=A1+A2+A3;
  const char *type="No Tremor";
  double conf=0;

  bool voluntary=meanNorm>0.7 && total<5;

  if(total<NOISE_FLOOR){
    type="No Tremor";
    conf=1.0;
  } else if(voluntary){
    type="Voluntary Movement";
    conf=0.6;
  } else {
    if(A1>A2 && A1>A3 && A1>0.3){ type="Parkinsonian"; conf=A1/total; }
    else if(A2>A1 && A2>A3 && A2>0.3){ type="Essential"; conf=A2/total; }
    else if(A3>A1 && A3>A2 && A3>0.3){ type="Physiological"; conf=A3/total; }
    else { type="Mixed/Weak"; conf=0.5; }
  }

  double score=0;
  if(total>=NOISE_FLOOR){
    score=log10(total/BASE_FOR_SCORE+1)*SCORE_SCALE;
    score=constrain(score,0.0,10.0);
  }

  sendBandsSSE(P1,P2,P3,type,conf,score,meanNorm);
}

// ----------------------- Setup -----------------------
void setup(){
  Serial.begin(115200);
  SPIFFS.begin(true);

  Wire.begin();
  mpu.begin();
  delay(200);
  mpu.calcOffsets();

  hpfX.initHPF(SAMPLE_RATE,3.5);
  hpfY.initHPF(SAMPLE_RATE,3.5);
  hpfZ.initHPF(SAMPLE_RATE,3.5);

  for(int i=0;i<MA_LEN;i++){ maAx[i]=maAy[i]=maAz[i]=maNorm[i]=0; }
  for(int i=0;i<WINDOW;i++){ windowBuf[i]=0; }

  pinMode(BUTTON_PIN,INPUT_PULLUP);
  pinMode(LED_PIN,OUTPUT);
  digitalWrite(LED_PIN,LOW);

  WiFi.softAP(AP_SSID,AP_PASS);
  Serial.println(WiFi.softAPIP());

  server.on("/",HTTP_GET,[](AsyncWebServerRequest *r){
    r->send(SPIFFS,"/index.html","text/html");
  });

  server.serveStatic("/",SPIFFS,"/");
  server.on("/startCalib",HTTP_GET,[](AsyncWebServerRequest *r){
    calibrationMode=true;
    calibStart=millis();
    calibSum=0;
    calibCount=0;
    r->send(200,"text/plain","OK");
  });

  server.addHandler(&events);
  server.begin();
}

// ----------------------- LOOP -----------------------
void loop(){
  // Button
  bool reading=digitalRead(BUTTON_PIN);
  if(reading!=lastState){
    lastDebounce=millis();
    lastState=reading;
  }
  if(millis()-lastDebounce>DEBOUNCE_MS){
    if(stableState!=reading){
      stableState=reading;

      if(stableState==LOW){
        pressStart=millis();
      } else {
        unsigned long pressDur=millis()-pressStart;

        if(pressDur>LONG_PRESS_MS){
          calibrationMode=true;
          calibStart=millis();
          calibSum=0;
          calibCount=0;
        } else {
          streaming=!streaming;
        }
      }
    }
  }

  // LED logic
  if(calibrationMode){
    if(millis()-lastBlink>BLINK_MS){
      lastBlink=millis();
      ledState=!ledState;
      digitalWrite(LED_PIN,ledState);
    }
  } else {
    digitalWrite(LED_PIN, streaming ? HIGH : LOW);
  }

  // Sampling timing
  static unsigned long lastMicros=0;
  unsigned long now=micros();
  if(now-lastMicros<(1000000/SAMPLE_RATE)) return;
  lastMicros=now;

  mpu.update();
  float axr=mpu.getAccX();
  float ayr=mpu.getAccY();
  float azr=mpu.getAccZ();

  double hpx=hpfX.process(axr);
  double hpy=hpfY.process(ayr);
  double hpz=hpfZ.process(azr);

  sumAx-=maAx[maIdx]; maAx[maIdx]=hpx; sumAx+=maAx[maIdx];
  sumAy-=maAy[maIdx]; maAy[maIdx]=hpy; sumAy+=maAy[maIdx];
  sumAz-=maAz[maIdx]; maAz[maIdx]=hpz; sumAz+=maAz[maIdx];

  maIdx++; if(maIdx>=MA_LEN){ maIdx=0; maFilled=true; }

  float meanAx=ma_get(sumAx);
  float meanAy=ma_get(sumAy);
  float meanAz=ma_get(sumAz);

  float dx=hpx-meanAx;
  float dy=hpy-meanAy;
  float dz=hpz-meanAz;

  float norm=sqrt(dx*dx+dy*dy+dz*dz);

  uint8_t pos=(maIdx==0?MA_LEN-1:maIdx-1);
  sumNorm-=maNorm[pos]; maNorm[pos]=norm; sumNorm+=maNorm[pos];
  float meanNorm=maFilled?sumNorm/MA_LEN:sumNorm/(winIdx+1);

  float tremor=norm-meanNorm;

  if(streaming) sendSample(dx,dy,dz);

  windowBuf[winIdx]=tremor;
  winIdx++;

  if(calibrationMode){
    calibSum+=fabs(tremor);
    calibCount++;

    if(millis()-calibStart>=CALIB_DURATION){
      double baseline=calibSum/calibCount;
      NOISE_FLOOR=max(0.001,baseline*1.8);
      BASE_FOR_SCORE=max(0.001,baseline*1.4);

      sendCalibrated(baseline);

      calibrationMode=false;
      digitalWrite(LED_PIN,LOW);
    }
  }

  if(winIdx>=WINDOW){
    double P1=0,P2=0,P3=0;
    for(double f:band1) P1+=goertzel(windowBuf,WINDOW,f,SAMPLE_RATE);
    for(double f:band2) P2+=goertzel(windowBuf,WINDOW,f,SAMPLE_RATE);
    for(double f:band3) P3+=goertzel(windowBuf,WINDOW,f,SAMPLE_RATE);

    P1/=3; P2/=3; P3/=3;

    classify(P1,P2,P3,meanNorm);
    sendBandsCSV(P1,P2,P3,meanNorm);

    winIdx=0;
  }
}

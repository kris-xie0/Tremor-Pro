// main.cpp -- Final calibrated band-based tremor detector
// Uses Goertzel bands (4-6,6-8,8-12 Hz), absolute scaling, voluntary-motion heuristic.

#include <Arduino.h>
#include <Wire.h>
#include <WiFi.h>
#include <ESPAsyncWebServer.h>
#include <SPIFFS.h>
#include <MPU6050_light.h>
#include <math.h>

const char *AP_SSID = "TremorDevice";
const char *AP_PASS = "12345678";

AsyncWebServer server(80);
AsyncEventSource events("/events");

MPU6050 mpu(Wire);

// Sampling and window
const double SAMPLE_RATE = 50.0;
const uint16_t WINDOW = 128;
double windowBuf[WINDOW];
uint16_t winIdx = 0;

// MA alignment
const uint8_t MA_LEN = 20;
float maAx[MA_LEN], maAy[MA_LEN], maAz[MA_LEN], maNorm[MA_LEN];
float sumAx=0, sumAy=0, sumAz=0, sumNorm=0;
uint8_t maIdx = 0;
bool maFilled = false;
float ma_get(float sum) { return sum / MA_LEN; } // MA getter (MA_LEN fixed)

// HPF biquad (RBJ)
struct Biquad {
  double a1,a2,b0,b1,b2;
  double x1=0,x2=0,y1=0,y2=0;
  void initHighpass(double fs,double fc,double Q=0.7071){
    double w0 = 2.0*M_PI*fc/fs;
    double cosw = cos(w0), sinw = sin(w0);
    double alpha = sinw/(2.0*Q);
    double b0n = (1.0 + cosw)/2.0;
    double b1n = -(1.0 + cosw);
    double b2n = (1.0 + cosw)/2.0;
    double a0n = 1.0 + alpha;
    double a1n = -2.0 * cosw;
    double a2n = 1.0 - alpha;
    b0 = b0n / a0n; b1 = b1n / a0n; b2 = b2n / a0n;
    a1 = a1n / a0n; a2 = a2n / a0n;
    x1=x2=y1=y2=0.0;
  }
  double process(double x){
    double y = b0*x + b1*x1 + b2*x2 - a1*y1 - a2*y2;
    x2=x1; x1=x; y2=y1; y1=y;
    return y;
  }
};
Biquad hpfX,hpfY,hpfZ;

// Goertzel helper
double goertzel_power(const double *data, uint16_t N, double freq, double fs){
  double omega = 2.0 * M_PI * freq / fs;
  double coeff = 2.0 * cos(omega);
  double s_prev = 0.0, s_prev2 = 0.0;
  for (uint16_t i=0;i<N;i++){
    double s = data[i] + coeff * s_prev - s_prev2;
    s_prev2 = s_prev;
    s_prev = s;
  }
  double power = s_prev2*s_prev2 + s_prev*s_prev - coeff*s_prev*s_prev2;
  if (!isfinite(power) || power < 0.0) power = 0.0;
  return power;
}

// Bands (representative freqs inside each band)
const double band1_freqs[] = {4.0,5.0,6.0};
const double band2_freqs[] = {6.0,7.0,8.0};
const double band3_freqs[] = {8.0,10.0,12.0};
const size_t B1N = sizeof(band1_freqs)/sizeof(double);
const size_t B2N = sizeof(band2_freqs)/sizeof(double);
const size_t B3N = sizeof(band3_freqs)/sizeof(double);

// Calibration constants (from your measurements)
const double NOISE_FLOOR = 0.01;   // below this -> no tremor
const double MAX_POWER    = 25.0;  // for UI absolute scaling
const double BASE_FOR_SCORE = 0.01;
const double SCORE_SCALE = 3.0;

// send sample (rate-limited)
void sendSampleSSE(float ax,float ay,float az){
  static uint8_t limiter=0; limiter++;
  if (limiter < 2) return;
  limiter = 0;
  char buf[120];
  snprintf(buf,sizeof(buf),"{\"ax\":%.4f,\"ay\":%.4f,\"az\":%.4f}",ax,ay,az);
  events.send(buf,"sample");
}

// send bands JSON (includes meanNorm and score)
void sendBandsSSE(double P1,double P2,double P3,const char* type,double conf,double score,double meanNorm){
  char buf[256];
  snprintf(buf,sizeof(buf),
    "{\"b1\":%.6f,\"b2\":%.6f,\"b3\":%.6f,\"type\":\"%s\",\"confidence\":%.3f,\"score\":%.3f,\"meanNorm\":%.4f}",
    P1,P2,P3,type,conf,score,meanNorm);
  events.send(buf,"bands");
}

// classification with absolute thresholds + voluntary-motion heuristic
void classify_and_send(double P1,double P2,double P3,double meanNorm){
  double total = P1 + P2 + P3 + 1e-12;
  // absolute floors
  double P1a = (P1 > NOISE_FLOOR) ? P1 : 0.0;
  double P2a = (P2 > NOISE_FLOOR) ? P2 : 0.0;
  double P3a = (P3 > NOISE_FLOOR) ? P3 : 0.0;
  double totalA = P1a + P2a + P3a;

  const char* type = "No Tremor";
  double confidence = 0.0;

  // voluntary-motion heuristic:
  // if meanNorm (slow movement) is large (e.g., >0.7g) and combined band energy is modest,
  // prefer "Voluntary Movement" to avoid false positives.
  bool voluntary = (meanNorm > 0.7 && totalA < 5.0); // heuristic thresholds tuned to your data

  if (totalA < NOISE_FLOOR) {
    type = "No Tremor";
    confidence = 1.0;
  } else if (voluntary) {
    type = "Voluntary Movement";
    confidence = 0.6;
  } else {
    // dominance + absolute band minimum to label
    if (P1a > P2a && P1a > P3a && P1a > 0.3) { type = "Parkinsonian"; confidence = P1a / totalA; }
    else if (P2a > P1a && P2a > P3a && P2a > 0.3) { type = "Essential"; confidence = P2a / totalA; }
    else if (P3a > P1a && P3a > P2a && P3a > 0.3) { type = "Physiological"; confidence = P3a / totalA; }
    else { type = "Mixed/Weak"; confidence = min(0.5, totalA / (totalA + NOISE_FLOOR)); }
  }

  // tremor score absolute mapping (log)
  double score = 0.0;
  if (totalA < NOISE_FLOOR) score = 0.0;
  else {
    double scaled = log10(totalA / BASE_FOR_SCORE + 1.0) * SCORE_SCALE;
    if (!isfinite(scaled)) scaled = 0.0;
    if (scaled < 0.0) scaled = 0.0;
    if (scaled > 10.0) scaled = 10.0;
    score = scaled;
  }

  sendBandsSSE(P1,P2,P3,type,confidence,score,meanNorm);
}

// setup
void setup(){
  Serial.begin(115200); delay(200);
  if (!SPIFFS.begin(true)) Serial.println("SPIFFS mount failed");

  Wire.begin();
  if (mpu.begin() != 0) Serial.println("MPU start fail");
  else { delay(200); mpu.calcOffsets(); }

  const double HPF_CUTOFF = 3.5;
  hpfX.initHighpass(SAMPLE_RATE, HPF_CUTOFF);
  hpfY.initHighpass(SAMPLE_RATE, HPF_CUTOFF);
  hpfZ.initHighpass(SAMPLE_RATE, HPF_CUTOFF);

  for (uint8_t i=0;i<MA_LEN;i++){ maAx[i]=maAy[i]=maAz[i]=maNorm[i]=0.0f; }
  for (uint16_t i=0;i<WINDOW;i++) windowBuf[i]=0.0;

  WiFi.softAP(AP_SSID,AP_PASS);
  Serial.print("AP IP: "); Serial.println(WiFi.softAPIP());

  server.on("/", HTTP_GET, [](AsyncWebServerRequest *r){ r->send(SPIFFS,"/index.html","text/html"); });
  server.serveStatic("/", SPIFFS, "/");
  server.addHandler(&events);
  server.begin();
  Serial.println("Server started.");
}

// main loop
void loop(){
  static unsigned long lastMicros = 0;
  unsigned long now = micros();
  unsigned long period = (unsigned long)(1000000.0 / SAMPLE_RATE);
  if (now - lastMicros < period) return;
  lastMicros = now;

  mpu.update();
  float rawAx = mpu.getAccX(), rawAy = mpu.getAccY(), rawAz = mpu.getAccZ();

  // HPF
  double hpx = hpfX.process((double)rawAx);
  double hpy = hpfY.process((double)rawAy);
  double hpz = hpfZ.process((double)rawAz);

  // aligned MA per-axis
  sumAx -= maAx[maIdx]; maAx[maIdx] = (float)hpx; sumAx += maAx[maIdx];
  sumAy -= maAy[maIdx]; maAy[maIdx] = (float)hpy; sumAy += maAy[maIdx];
  sumAz -= maAz[maIdx]; maAz[maIdx] = (float)hpz; sumAz += maAz[maIdx];

  maIdx++; if (maIdx >= MA_LEN) { maIdx = 0; maFilled = true; }

  float meanAx = ma_get(sumAx);
  float meanAy = ma_get(sumAy);
  float meanAz = ma_get(sumAz);

  // detrended axes
  float dx = (float)hpx - meanAx;
  float dy = (float)hpy - meanAy;
  float dz = (float)hpz - meanAz;

  // norm & meanNorm (slow component)
  float norm = sqrtf(dx*dx + dy*dy + dz*dz);
  uint8_t writePos = (maIdx == 0) ? (MA_LEN - 1) : (maIdx - 1);
  sumNorm -= maNorm[writePos]; maNorm[writePos] = norm; sumNorm += maNorm[writePos];
  if (!maFilled && writePos == (MA_LEN - 1)) maFilled = true;
  float meanNorm = maFilled ? (sumNorm / MA_LEN) : (sumNorm / (winIdx + 1));

  // zero-mean tremor sample
  float tremorSample = norm - meanNorm;

  // push to window
  windowBuf[winIdx] = (double)tremorSample;
  winIdx++;

  // sample SSE for waveform
  sendSampleSSE(dx,dy,dz);

  // window complete
  if (winIdx >= WINDOW){
    double P1=0.0,P2=0.0,P3=0.0;
    for (size_t i=0;i<B1N;i++) P1 += goertzel_power(windowBuf,WINDOW,band1_freqs[i],SAMPLE_RATE);
    for (size_t i=0;i<B2N;i++) P2 += goertzel_power(windowBuf,WINDOW,band2_freqs[i],SAMPLE_RATE);
    for (size_t i=0;i<B3N;i++) P3 += goertzel_power(windowBuf,WINDOW,band3_freqs[i],SAMPLE_RATE);

    // normalize by sampled freqs (keeps ranges sensible)
    P1 /= (double)B1N; P2 /= (double)B2N; P3 /= (double)B3N;

    // print for debug if needed
    Serial.printf("P1: %.6f   P2: %.6f   P3: %.6f   meanNorm: %.4f\n", P1, P2, P3, meanNorm);

    // classify and send
    classify_and_send(P1,P2,P3,meanNorm);

    // send compact CSV for UI (absolute powers)
    char col[160];
    snprintf(col,sizeof(col),"%.6f,%.6f,%.6f,%.4f", P1,P2,P3, meanNorm);
    events.send(col,"bands_csv");

    winIdx = 0;
  }
}

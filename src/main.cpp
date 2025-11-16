#include <Arduino.h>
#include <Wire.h>
#include <WiFi.h>
#include <ESPAsyncWebServer.h>
#include <SPIFFS.h>
#include <MPU6050_light.h>
#include <math.h>

// =======================================================
//  WiFi AP Mode
// =======================================================
const char *AP_SSID = "TremorDevice";
const char *AP_PASS = "12345678";

AsyncWebServer server(80);
AsyncEventSource events("/events");

// =======================================================
//  MPU Setup
// =======================================================
MPU6050 mpu(Wire);

// =======================================================
//  Sampling & Window Settings
// =======================================================
const double SAMPLE_RATE = 50.0;
const uint16_t WINDOW = 128;  // ~2.56s window

double windowBuf[WINDOW];
uint16_t winIdx = 0;

// =======================================================
//  Moving Average Filter (Aligned)
// =======================================================
const uint8_t MA_LEN = 20;

float maAx[MA_LEN], maAy[MA_LEN], maAz[MA_LEN], maNorm[MA_LEN];
float sumAx = 0, sumAy = 0, sumAz = 0, sumNorm = 0;
uint8_t maIdx = 0;
bool maFilled = false;

float ma_get(float sum) {
    return sum / MA_LEN;
}

// =======================================================
//  High-Pass Filter (Biquad)
// =======================================================
struct Biquad {
    double a1, a2, b0, b1, b2;
    double x1=0, x2=0, y1=0, y2=0;

    void initHighpass(double fs, double fc, double Q = 0.7071) {
        double w0 = 2.0 * M_PI * fc / fs;
        double cosw = cos(w0), sinw = sin(w0);
        double alpha = sinw / (2.0 * Q);

        double b0n = (1.0 + cosw) / 2.0;
        double b1n = -(1.0 + cosw);
        double b2n = (1.0 + cosw) / 2.0;

        double a0n = 1.0 + alpha;
        double a1n = -2.0 * cosw;
        double a2n = 1.0 - alpha;

        b0 = b0n / a0n;
        b1 = b1n / a0n;
        b2 = b2n / a0n;
        a1 = a1n / a0n;
        a2 = a2n / a0n;

        x1=x2=y1=y2=0;
    }

    double process(double x) {
        double y = b0*x + b1*x1 + b2*x2 - a1*y1 - a2*y2;
        x2=x1; x1=x; y2=y1; y1=y;
        return y;
    }
};

Biquad hpfX, hpfY, hpfZ;

// =======================================================
//  Goertzel Band Powers (Representative Frequencies)
// =======================================================
double goertzel_power(const double *data, uint16_t N, double freq, double fs) {
    double omega = 2.0 * M_PI * freq / fs;
    double coeff = 2.0 * cos(omega);

    double s_prev = 0.0, s_prev2 = 0.0;

    for (uint16_t i = 0; i < N; i++) {
        double s = data[i] + coeff * s_prev - s_prev2;
        s_prev2 = s_prev;
        s_prev = s;
    }

    double power = s_prev2*s_prev2 + s_prev*s_prev - coeff*s_prev*s_prev2;

    if (!isfinite(power) || power < 0.0) power = 0.0;
    return power;
}

const double band1_freqs[] = {4.0, 5.0, 6.0};  // Parkinsonian
const double band2_freqs[] = {6.0, 7.0, 8.0};  // Essential
const double band3_freqs[] = {8.0,10.0,12.0};   // Physiological

const size_t B1N = sizeof(band1_freqs)/sizeof(double);
const size_t B2N = sizeof(band2_freqs)/sizeof(double);
const size_t B3N = sizeof(band3_freqs)/sizeof(double);

// =======================================================
//  Calibration Variables
// =======================================================
double NOISE_FLOOR = 0.01;
double BASE_FOR_SCORE = 0.01;
double SCORE_SCALE = 3.0;
double MAX_POWER = 25.0;

bool calibrationMode = false;
unsigned long calibStart = 0;
double calibSum = 0.0;
unsigned long calibCount = 0;
const unsigned long CALIB_DURATION = 5000;

// =======================================================
//  Session Stats
// =======================================================
unsigned long sessionStart = 0;
double sessionScoreSum = 0.0;
double sessionPeak = 0.0;
unsigned long sessionWindows = 0;
unsigned long dom1=0, dom2=0, dom3=0, voluntaryCount=0;

// =======================================================
//  SSE Helpers
// =======================================================
void sendSampleSSE(float x, float y, float z) {
    static uint8_t lim = 0;
    if (++lim < 2) return;
    lim = 0;

    char buf[120];
    snprintf(buf, sizeof(buf), "{\"ax\":%.4f,\"ay\":%.4f,\"az\":%.4f}", x,y,z);
    events.send(buf, "sample");
}

void sendBandsSSE(double P1,double P2,double P3,const char* type,double conf,double score,double meanNorm) {
    char buf[256];
    snprintf(buf,sizeof(buf),
        "{\"b1\":%.6f,\"b2\":%.6f,\"b3\":%.6f,"
        "\"type\":\"%s\",\"confidence\":%.3f,\"score\":%.3f,"
        "\"meanNorm\":%.4f}",
        P1,P2,P3,type,conf,score,meanNorm
    );
    events.send(buf,"bands");
}

void sendCalibratedSSE(double baseline,double nf,double bfs) {
    char buf[180];
    snprintf(buf,sizeof(buf),
        "{\"baseline\":%.6f,\"noiseFloor\":%.6f,\"baseForScore\":%.6f}",
        baseline,nf,bfs
    );
    events.send(buf,"calibrated");
}

void sendSessionSSE() {
    unsigned long now = millis();
    unsigned long dur = (sessionStart==0) ? 0 : (now - sessionStart);
    double avg = (sessionWindows==0)?0:(sessionScoreSum/sessionWindows);

    const char *dom = "None";
    if (dom1>dom2 && dom1>dom3) dom="Parkinsonian";
    else if (dom2>dom1 && dom2>dom3) dom="Essential";
    else if (dom3>dom1 && dom3>dom2) dom="Physiological";

    char buf[300];
    snprintf(buf,sizeof(buf),
      "{\"duration_ms\":%lu,\"avgScore\":%.3f,\"peakScore\":%.3f,"
      "\"windows\":%lu,\"dominant\":\"%s\"}",
      dur,avg,sessionPeak,sessionWindows,dom
    );
    events.send(buf,"session");
}

// =======================================================
//  CLASSIFICATION LOGIC
// =======================================================
void classify_and_send(double P1,double P2,double P3,double meanNorm) {

    double P1a = (P1 > NOISE_FLOOR)?P1:0;
    double P2a = (P2 > NOISE_FLOOR)?P2:0;
    double P3a = (P3 > NOISE_FLOOR)?P3:0;

    double totalA = P1a + P2a + P3a;

    bool voluntary = (meanNorm > 0.7 && totalA < 5.0);

    const char *type="No Tremor";
    double conf=0;

    if (totalA < NOISE_FLOOR) {
        type="No Tremor"; conf=1.0;
    } else if (voluntary) {
        type="Voluntary Movement"; conf=0.6;
        voluntaryCount++;
    } else {
        if (P1a>P2a && P1a>P3a && P1a>0.3) { type="Parkinsonian"; conf=P1a/(totalA+1e-12); dom1++; }
        else if (P2a>P1a && P2a>P3a && P2a>0.3) { type="Essential"; conf=P2a/(totalA+1e-12); dom2++; }
        else if (P3a>P1a && P3a>P2a && P3a>0.3) { type="Physiological"; conf=P3a/(totalA+1e-12); dom3++; }
        else { type="Mixed/Weak"; conf = min(0.5, totalA/(totalA+NOISE_FLOOR)); }
    }

    // Score mapping (log absolute)
    double score=0;
    if (totalA < NOISE_FLOOR) score=0;
    else {
        double scaled = log10(totalA/BASE_FOR_SCORE + 1.0) * SCORE_SCALE;
        if (!isfinite(scaled)) scaled=0;
        score = constrain(scaled, 0.0, 10.0);
    }

    // Update session
    if (sessionStart==0) sessionStart = millis();
    sessionWindows++;
    sessionScoreSum += score;
    if (score > sessionPeak) sessionPeak = score;

    sendBandsSSE(P1,P2,P3,type,conf,score,meanNorm);

    if (sessionWindows % 10 == 0) sendSessionSSE();
}

// =======================================================
//  SETUP
// =======================================================
void setup() {
    Serial.begin(115200);
    delay(200);

    if (!SPIFFS.begin(true)) Serial.println("SPIFFS mount failed");

    Wire.begin();
    if (mpu.begin()!=0) Serial.println("MPU FAIL");
    delay(200);
    mpu.calcOffsets();

    hpfX.initHighpass(SAMPLE_RATE, 3.5);
    hpfY.initHighpass(SAMPLE_RATE, 3.5);
    hpfZ.initHighpass(SAMPLE_RATE, 3.5);

    for (int i=0;i<MA_LEN;i++) maAx[i]=maAy[i]=maAz[i]=maNorm[i]=0;
    for (int i=0;i<WINDOW;i++) windowBuf[i]=0;

    WiFi.softAP(AP_SSID,AP_PASS);
    Serial.print("AP IP: "); Serial.println(WiFi.softAPIP());

    // Serve index
    server.on("/", HTTP_GET, [](AsyncWebServerRequest*r){
        r->send(SPIFFS,"/index.html","text/html");
    });
    server.serveStatic("/", SPIFFS, "/");

    // Start calibration
    server.on("/startCalib",HTTP_GET,[](AsyncWebServerRequest*r){
        calibrationMode=true;
        calibStart=millis();
        calibSum=0;
        calibCount=0;
        r->send(200,"text/plain","OK");
    });

    // Session summary on demand
    server.on("/getSession", HTTP_GET, [](AsyncWebServerRequest*r){
        unsigned long now=millis();
        unsigned long dur = (sessionStart==0)?0:(now-sessionStart);
        double avg = (sessionWindows==0)?0:(sessionScoreSum/sessionWindows);

        const char *dom="None";
        if (dom1>dom2 && dom1>dom3) dom="Parkinsonian";
        else if (dom2>dom1 && dom2>dom3) dom="Essential";
        else if (dom3>dom1 && dom3>dom2) dom="Physiological";

        String out="{";
        out+="\"duration_ms\":"+String(dur)+",";
        out+="\"avgScore\":"+String(avg,3)+",";
        out+="\"peakScore\":"+String(sessionPeak,3)+",";
        out+="\"windows\":"+String(sessionWindows)+",";
        out+="\"dominant\":\""+String(dom)+"\"";
        out+="}";
        r->send(200,"application/json",out);
    });

    server.addHandler(&events);
    server.begin();
}

// =======================================================
//  LOOP — Sampling, HPF, MA, detrend, norm, window, bands
// =======================================================
void loop() {
    static unsigned long lastMicros=0;
    unsigned long now=micros();
    unsigned long period = (unsigned long)(1000000.0/SAMPLE_RATE);

    if (now-lastMicros < period) return;
    lastMicros = now;

    mpu.update();

    float rawAx=mpu.getAccX(), rawAy=mpu.getAccY(), rawAz=mpu.getAccZ();

    // HPF
    double hpx=hpfX.process(rawAx);
    double hpy=hpfY.process(rawAy);
    double hpz=hpfZ.process(rawAz);

    // MA alignment
    sumAx -= maAx[maIdx]; maAx[maIdx]=hpx; sumAx+=maAx[maIdx];
    sumAy -= maAy[maIdx]; maAy[maIdx]=hpy; sumAy+=maAy[maIdx];
    sumAz -= maAz[maIdx]; maAz[maIdx]=hpz; sumAz+=maAz[maIdx];

    float meanAx = ma_get(sumAx);
    float meanAy = ma_get(sumAy);
    float meanAz = ma_get(sumAz);

    float dx = hpx - meanAx;
    float dy = hpy - meanAy;
    float dz = hpz - meanAz;

    float norm = sqrt(dx*dx + dy*dy + dz*dz);

    uint8_t idx2 = (maIdx==0)?(MA_LEN-1):(maIdx-1);
    sumNorm -= maNorm[idx2];
    maNorm[idx2] = norm;
    sumNorm += maNorm[idx2];

    if (!maFilled && idx2==(MA_LEN-1)) maFilled=true;

    float meanNorm = maFilled? (sumNorm/MA_LEN) : (sumNorm/(idx2+1));

    float tremorSample = norm - meanNorm;

    // push to window
    windowBuf[winIdx++] = tremorSample;

    // sample SSE
    sendSampleSSE(dx,dy,dz);

    // calibration process
    if (calibrationMode) {
        calibSum += fabs(tremorSample);
        calibCount++;

        if (millis() - calibStart >= CALIB_DURATION) {
            double baseline = calibSum / (double)calibCount;
            NOISE_FLOOR = max(0.001, baseline * 1.8);
            BASE_FOR_SCORE = max(0.001, baseline * 1.4);

            sendCalibratedSSE(baseline,NOISE_FLOOR,BASE_FOR_SCORE);

            calibrationMode=false;
            calibSum=0;
            calibCount=0;

            Serial.printf("Calib done baseline=%.6f NF=%.6f BFS=%.6f\n",
                baseline,NOISE_FLOOR,BASE_FOR_SCORE);
        }
    }

    // When window full → compute band powers
    if (winIdx >= WINDOW) {

        double P1=0,P2=0,P3=0;

        for (size_t i=0;i<B1N;i++) P1 += goertzel_power(windowBuf,WINDOW,band1_freqs[i],SAMPLE_RATE);
        for (size_t i=0;i<B2N;i++) P2 += goertzel_power(windowBuf,WINDOW,band2_freqs[i],SAMPLE_RATE);
        for (size_t i=0;i<B3N;i++) P3 += goertzel_power(windowBuf,WINDOW,band3_freqs[i],SAMPLE_RATE);

        P1/=B1N; P2/=B2N; P3/=B3N;

        // Serial debug
        Serial.printf("P1=%.6f P2=%.6f P3=%.6f meanNorm=%.4f\n",P1,P2,P3,meanNorm);

        classify_and_send(P1,P2,P3,meanNorm);

        // CSV helper SSE
        char csvLine[128];
        snprintf(csvLine, sizeof(csvLine), "%.6f,%.6f,%.6f,%.4f", P1,P2,P3,meanNorm);
        events.send(csvLine, "bands_csv");

        winIdx = 0;
    }

    maIdx++;
    if (maIdx >= MA_LEN) maIdx = 0;
}

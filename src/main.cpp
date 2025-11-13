#include <Arduino.h>
#include <Wire.h>
#include <WiFi.h>
#include <SPIFFS.h>

#include "MPU6050_light.h"

#include <AsyncTCP.h>
#include <ESPAsyncWebServer.h>

MPU6050 mpu(Wire);

// =============================
//       FILTER CONSTANTS
// =============================
const float HPF_ALPHA = 0.95;   // High-pass strength (gravity removal)
const float LPF_ALPHA = 0.20;   // Low-pass smoothing (noise removal)

// Previous samples for HPF + LPF
float prevRawX = 0, prevRawY = 0, prevRawZ = 0;
float prevHPFX = 0, prevHPFY = 0, prevHPFZ = 0;

float prevBPFx = 0, prevBPFy = 0, prevBPFz = 0;

// =============================
//        WiFi + SERVER
// =============================
AsyncWebServer server(80);
AsyncEventSource events("/events");

const char* ap_ssid = "TremorDevice";
const char* ap_pass = "12345678";

// =================================================
//              FILTER FUNCTIONS
// =================================================

float highPass(float current, float prevRaw, float prevFiltered) {
    return HPF_ALPHA * (prevFiltered + current - prevRaw);
}

float lowPass(float current, float prevFiltered) {
    return prevFiltered + LPF_ALPHA * (current - prevFiltered);
}

float bandPass(float raw, float &prevRaw, float &prevHPF, float &prevLPF) {
    float hpf = highPass(raw, prevRaw, prevHPF);
    prevRaw = raw;
    prevHPF = hpf;

    float bpf = lowPass(hpf, prevLPF);
    prevLPF = bpf;

    return bpf;
}

// =================================================
//            SEND DATA TO BROWSER
// =================================================
void sendSensorData() {
    mpu.update();

    // Raw accelerometer data (in Gs)
    float axRaw = mpu.getAccX();
    float ayRaw = mpu.getAccY();
    float azRaw = mpu.getAccZ();

    // Apply band-pass filtering
    float ax = bandPass(axRaw, prevRawX, prevHPFX, prevBPFx);
    float ay = bandPass(ayRaw, prevRawY, prevHPFY, prevBPFy);
    float az = bandPass(azRaw, prevRawZ, prevHPFZ, prevBPFz);

    // Format as "x,y,z"
    String payload = String(ax, 4) + "," + String(ay, 4) + "," + String(az, 4);

    events.send(payload.c_str(), "message");
}

// =================================================
//                    SETUP
// =================================================
void setup() {
    Serial.begin(115200);
    delay(300);

    // -------- SPIFFS FILESYSTEM --------
    if (!SPIFFS.begin(true)) {
        Serial.println("SPIFFS Mount Failed!");
        return;
    }
    Serial.println("SPIFFS mounted successfully.");

    // -------- I2C + MPU --------
    Wire.begin(21, 22);
    delay(200);

    Serial.println("Initializing MPU6050...");
    byte status = mpu.begin();

    if (status != 0) {
        Serial.println("MPU FAIL — ignoring and continuing.");
    } else {
        Serial.println("MPU Ready.");
        mpu.calcOffsets();
    }

    // -------- WIFI ACCESS POINT --------
    Serial.println("Starting WiFi Access Point...");
    WiFi.mode(WIFI_AP);
    WiFi.softAP(ap_ssid, ap_pass);
    Serial.print("AP IP: ");
    Serial.println(WiFi.softAPIP());

    // -------- HTTP ROUTES --------
    server.on("/", HTTP_GET, [](AsyncWebServerRequest *request) {
        request->send(SPIFFS, "/index.html", "text/html");
    });

    server.serveStatic("/", SPIFFS, "/");

    // SSE / REALTIME STREAM
    server.addHandler(&events);

    server.begin();
    Serial.println("HTTP server started.");
}

// =================================================
//                    LOOP
// =================================================
unsigned long lastSend = 0;

void loop() {
    unsigned long now = millis();

    // 50 Hz data stream to browser (20ms)
    if (now - lastSend >= 20) {
        sendSensorData();
        lastSend = now;
    }
}

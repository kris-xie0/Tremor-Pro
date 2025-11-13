#include <WiFi.h>
#include <WebServer.h>
#include <Wire.h>
#include "MPU6050.h"

MPU6050 mpu;

// ---------------------------
// WIFI AP CONFIG
// ---------------------------
const char* ssid = "TremorDevice";
const char* password = "12345678";

WebServer server(80);

// ---------------------------
// HTML PAGE WITH CUSTOM GRAPH
// ---------------------------
const char MAIN_page[] PROGMEM = R"=====(
<!DOCTYPE html>
<html>
<head>
<title>Tremor Dashboard</title>
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
    body { background:#000; color:#fff; font-family:Arial; padding:20px; }
    h2 { margin-bottom:5px; }
</style>
</head>
<body>

<h2>Tremor Dashboard</h2>
<p>Status: <span id="status">Connected</span></p>

<canvas id="chart" width="900" height="300" style="border:1px solid #333;"></canvas>

<script>
let canvas = document.getElementById('chart');
let ctx = canvas.getContext('2d');

let width = canvas.width;
let height = canvas.height;

let dataX = new Array(200).fill(0);
let dataY = new Array(200).fill(0);
let dataZ = new Array(200).fill(0);

function draw() {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, width, height);

    function line(data, color) {
        ctx.strokeStyle = color;
        ctx.beginPath();
        for (let i = 0; i < data.length; i++) {
            let x = (i / data.length) * width;
            let y = height/2 - (data[i] * 40);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.stroke();
    }

    line(dataX, "red");
    line(dataY, "green");
    line(dataZ, "blue");

    requestAnimationFrame(draw);
}
draw();

async function poll() {
  try {
    const r = await fetch("/data");
    const t = await r.text();
    const p = t.split(",");

    let x = parseFloat(p[0]);
    let y = parseFloat(p[1]);
    let z = parseFloat(p[2]);

    dataX.push(x); dataX.shift();
    dataY.push(y); dataY.shift();
    dataZ.push(z); dataZ.shift();

  } catch(e) {}

  setTimeout(poll, 30);
}
poll();
</script>

</body>
</html>
)=====";


// ---------------------------
// SEND HTML PAGE
// ---------------------------
void handleRoot() {
    server.send_P(200, "text/html", MAIN_page);
}

// ---------------------------
// SEND SENSOR VALUES
// ---------------------------
void handleData() {
    int16_t ax, ay, az;
    mpu.getAcceleration(&ax, &ay, &az);

    // Convert to G values (~16384 per G)
    float x = ax / 16384.0;
    float y = ay / 16384.0;
    float z = az / 16384.0;

    String s = String(x, 3) + "," + String(y, 3) + "," + String(z, 3);
    server.send(200, "text/plain", s);
}

// ---------------------------
// SETUP
// ---------------------------
void setup() {
    Serial.begin(115200);
    Wire.begin();

    Serial.println("Initializing MPU6050...");
    mpu.initialize();
    delay(500);

    Serial.print("Test connection: ");
    Serial.println(mpu.testConnection() ? "MPU SUCCESS" : "MPU FAILURE");

    Serial.println("Starting WiFi AP...");
    WiFi.mode(WIFI_AP);
    WiFi.softAP(ssid, password);

    Serial.print("AP IP: ");
    Serial.println(WiFi.softAPIP());

    server.on("/", handleRoot);
    server.on("/data", handleData);

    server.begin();
    Serial.println("HTTP server started");
}

// ---------------------------
// LOOP
// ---------------------------
void loop() {
    server.handleClient();
}

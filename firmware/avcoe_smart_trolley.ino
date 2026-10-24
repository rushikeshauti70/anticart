/*
 * =========================================================================================
 * AVCOE SMART TROLLEY - MERGED ESP32 FIRMWARE (v3.0.0)
 * =========================================================================================
 *  - Web-app contract (topics, JSON envelopes, commands, ACKs, LWT) : kept identical to the
 *    AI Studio firmware, so the web application needs NO change.
 *  - Driving logic (PD line following, sonar scan, detour, realign, backup/blocked wait) :
 *    taken from the "Smart Car" sketch.
 *
 * ARCHITECTURE (why it is safe to drive and talk at the same time)
 *   Core 1 (Arduino loop) : sensors + state machine + motors. NEVER blocks on WiFi/MQTT.
 *   Core 0 (networkTask)  : WiFi, NTP, MQTT, telemetry, commands.
 *   If WiFi/MQTT drops, the trolley keeps following the line on its own and the network
 *   task reconnects in the background.
 *
 * Target   : ESP32 DevKit V1 / ESP32-WROOM-32
 * Requires : Arduino-ESP32 core 3.x, libraries: PubSubClient (Nick O'Leary),
 *            ArduinoJson (Benoit Blanchon, v6 or v7), ESP32Servo (recent version for core 3.x)
 *
 * WIRING (L298N ENA/ENB jumpers ON, 5V -> 3.3V divider on ECHO!)
 *   Left motors  IN1/IN2 : GPIO 25 / 26      Right motors IN3/IN4 : GPIO 27 / 14
 *   IR left/center/right : GPIO 34 / 35 / 39 (input-only, module must drive the pin itself)
 *   HC-SR04 TRIG / ECHO  : GPIO 23 / 22      Servo signal         : GPIO 21
 *   Status LED           : GPIO 2            Buzzer               : GPIO 4
 *
 * CALIBRATE FIRST (wheels lifted, then on the floor):
 *   IR_DETECTED_LEVEL, INVERT_*_MOTORS, SERVO_LEFT/RIGHT_ANGLE, TURN_90_MS, BYPASS_SIDE_MS,
 *   BYPASS_PASS_MS, LEFT_TRIM/RIGHT_TRIM, MOTOR_MIN_PWM.
 * =========================================================================================
 */

#include <Arduino.h>
#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <time.h>
#include <ESP32Servo.h>
#include "driver/gpio.h"

// ======================== 1. USER CONFIGURATION (WEB APP CONTRACT) ========================
const char* WIFI_SSID     = "android";
const char* WIFI_PASSWORD = "12341234";

const char* MQTT_BROKER   = "broker.emqx.io";
const int   MQTT_PORT     = 1883;
const char* MQTT_USER     = "";   // leave empty if unauthenticated
const char* MQTT_PASS     = "";

const char* DEVICE_ID     = "trolley-01";     // must match ALLOWED_DEVICE_IDS on the server
const char* TOPIC_PREFIX  = "avcoeshop/v1";
const char* FW_VERSION    = "v3.0.0-esp32";

const unsigned long TELEMETRY_INTERVAL_MS = 2000;
const unsigned long MQTT_RETRY_MS         = 5000;
const unsigned long WIFI_RETRY_MS         = 15000;

// Extra fault strings ("LINE_LOST", "PATH_BLOCKED") in telemetry.fault.
// Keep false unless your server accepts free-text fault values.
constexpr bool ENABLE_FAULT_REPORTING = false;

// ============================ 2. PINS ============================
constexpr uint8_t LEFT_IN1  = 25;
constexpr uint8_t LEFT_IN2  = 26;
constexpr uint8_t RIGHT_IN1 = 27;
constexpr uint8_t RIGHT_IN2 = 14;

constexpr uint8_t IR_LEFT   = 34;   // input-only pins, no internal pull-ups
constexpr uint8_t IR_CENTER = 35;
constexpr uint8_t IR_RIGHT  = 39;

constexpr uint8_t TRIG_PIN  = 23;
constexpr uint8_t ECHO_PIN  = 22;   // MUST go through a 5V -> 3.3V divider
constexpr uint8_t SERVO_PIN = 21;

constexpr uint8_t PIN_LED    = 2;
constexpr uint8_t PIN_BUZZER = 4;

// ============================ 3. TUNING ==========================
// --- IR ---
constexpr int IR_DETECTED_LEVEL = LOW;

// --- Servo ---
constexpr int      SERVO_CENTER      = 90;
constexpr int      SERVO_LEFT_ANGLE  = 150;
constexpr int      SERVO_RIGHT_ANGLE = 30;
constexpr uint32_t SERVO_SETTLE_MS   = 350;

// --- Ultrasonic ---
constexpr uint32_t SONAR_INTERVAL_MS  = 60;
constexpr uint32_t SONAR_TIMEOUT_US   = 25000UL;
constexpr float    NO_ECHO_CM         = 400.0f;
constexpr float    OBSTACLE_STOP_CM   = 30.0f;
constexpr float    OBSTACLE_RESUME_CM = 40.0f;
constexpr float    SLOW_ZONE_CM       = 70.0f;
constexpr float    MIN_SLOW_SCALE     = 0.55f;
constexpr float    MIN_SIDE_CLEARANCE_CM = 35.0f;
constexpr uint8_t  SCAN_SAMPLES       = 3;
constexpr uint32_t OBS_WAIT_MS        = 800;

// --- Speeds (-255..255) ---
constexpr int FORWARD_SPEED = 155;
constexpr int GENTLE_SPEED  = 105;
constexpr int TURN_SPEED    = 170;
constexpr int SEARCH_SPEED  = 90;
constexpr int BYPASS_SPEED  = 140;
constexpr int REALIGN_SPEED = 120;
constexpr int BACKUP_SPEED  = 120;

// --- Line following ---
constexpr float    KP = 30.0f;
constexpr float    KD = 12.0f;
constexpr int      CORNER_SLOWDOWN   = 20;
constexpr int      SHARP_INNER_SPEED = -50;
constexpr uint32_t CONTROL_PERIOD_MS = 10;
constexpr uint32_t LOST_COAST_MS     = 250;
constexpr uint32_t SEARCH_FIRST_MS   = 1000;
constexpr uint32_t SEARCH_SECOND_MS  = 2000;
constexpr uint32_t ALL_SENSORS_MAX_MS = 3000;

// --- Detour (timed manoeuvres) ---
constexpr uint32_t TURN_90_MS           = 480;
constexpr uint32_t BYPASS_SIDE_MS       = 700;
constexpr uint32_t BYPASS_PASS_MS       = 1200;
constexpr uint32_t BYPASS_RETURN_MAX_MS = 2500;
constexpr uint32_t REALIGN_MIN_MS       = 250;
constexpr uint32_t REALIGN_MAX_MS       = 1200;
constexpr uint32_t BACKUP_MS            = 350;
constexpr bool     ENABLE_BACKUP        = true;
constexpr uint8_t  MAX_AVOID_ATTEMPTS   = 3;
constexpr uint32_t BLOCKED_RECHECK_MS   = 2000;

// --- Motors ---
constexpr uint32_t MOTOR_PWM_FREQ   = 1000;
constexpr uint8_t  PWM_BITS         = 8;
constexpr int      MOTOR_MIN_PWM    = 60;
constexpr int      RAMP_UP          = 40;
constexpr int      RAMP_DOWN        = 80;
constexpr uint32_t MOTOR_UPDATE_MS  = 10;
constexpr float    LEFT_TRIM        = 1.00f;
constexpr float    RIGHT_TRIM       = 1.00f;
constexpr bool     INVERT_LEFT_MOTORS  = false;
constexpr bool     INVERT_RIGHT_MOTORS = false;

// --- Logging ---
constexpr uint32_t LOG_INTERVAL_MS = 150;

// ============================ 4. SHARED (CORE 1 <-> CORE 0) ============================
// Remote-control state, written by the network task, read by the driving loop.
volatile bool    motorsEnabled = true;
volatile uint8_t opMode = 0;                       // index into MODE_NAMES
const char* const MODE_NAMES[] = {"LINE_FOLLOW", "PAUSED", "STOPPED"};

// Sensor snapshot, written by the driving loop, read by the network task.
struct Snapshot {
  bool irL, irC, irR;
  float frontCm;
  bool frontValid;
  int servoAngle;
  bool obstacle;
  const char* fault;
};
Snapshot snap = {false, false, false, NO_ECHO_CM, false, SERVO_CENTER, false, nullptr};
portMUX_TYPE snapMux = portMUX_INITIALIZER_UNLOCKED;

// Events raised by the driving loop, published by the network task.
enum EventId : uint8_t { EVT_OBSTACLE = 1 };
QueueHandle_t eventQueue = nullptr;

// ============================ 5. NETWORK (CORE 0) ============================
WiFiClient   espClient;
PubSubClient client(espClient);

char topicTelemetry[128];
char topicStatus[128];
char topicCommandAck[128];
char topicEvents[128];
char topicCommands[128];

String   recentIds[8];
uint8_t  recentHead = 0;
bool     bootEventSent = false;
bool     ntpStarted = false;
uint32_t ledBlinkUntil = 0;

String getIsoTimestamp() {
  time_t now;
  time(&now);
  struct tm timeinfo;
  gmtime_r(&now, &timeinfo);
  char buf[30];
  strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%SZ", &timeinfo);
  return String(buf);
}

bool timeIsValid() { return time(nullptr) > 1700000000L; }

void publishStatus(const char* state) {
  StaticJsonDocument<512> doc;
  doc["v"] = 1;
  doc["deviceId"] = DEVICE_ID;
  doc["ts"] = getIsoTimestamp();
  doc["type"] = "status";

  JsonObject payload = doc.createNestedObject("payload");
  payload["state"] = state;
  payload["fw"] = FW_VERSION;
  payload["ip"] = WiFi.localIP().toString();
  payload["rssi"] = WiFi.RSSI();
  payload["motorsEnabled"] = (bool)motorsEnabled;

  char buffer[512];
  serializeJson(doc, buffer);
  client.publish(topicStatus, buffer, true);   // retained
  Serial.printf("[STATUS] Published %s\n", state);
}

void publishEvent(const char* eventName, const char* severity, const char* message) {
  StaticJsonDocument<512> doc;
  doc["v"] = 1;
  doc["deviceId"] = DEVICE_ID;
  doc["ts"] = getIsoTimestamp();
  doc["type"] = "event";

  JsonObject payload = doc.createNestedObject("payload");
  payload["event"] = eventName;
  payload["severity"] = severity;
  if (message != nullptr) payload["message"] = message;

  char buffer[512];
  serializeJson(doc, buffer);
  client.publish(topicEvents, buffer, false);
}

void publishCommandAck(const char* commandId, const char* status, const char* reason) {
  StaticJsonDocument<512> doc;
  doc["v"] = 1;
  doc["deviceId"] = DEVICE_ID;
  doc["ts"] = getIsoTimestamp();
  doc["type"] = "command-ack";

  JsonObject payload = doc.createNestedObject("payload");
  payload["commandId"] = commandId;
  payload["status"] = status;       // accepted | executed | rejected | expired
  if (reason != nullptr) payload["reason"] = reason;

  char buffer[512];
  serializeJson(doc, buffer);
  client.publish(topicCommandAck, buffer, false);
  Serial.printf("[ACK] %s: %s (%s)\n", commandId, status, reason ? reason : "ok");
}

void publishTelemetry() {
  Snapshot s;
  portENTER_CRITICAL(&snapMux);
  s = snap;
  portEXIT_CRITICAL(&snapMux);

  StaticJsonDocument<768> doc;
  doc["v"] = 1;
  doc["deviceId"] = DEVICE_ID;
  doc["ts"] = getIsoTimestamp();
  doc["type"] = "telemetry";

  JsonObject payload = doc.createNestedObject("payload");
  payload["mode"] = MODE_NAMES[opMode];

  JsonObject ir = payload.createNestedObject("ir");
  ir["left"]   = s.irL;
  ir["center"] = s.irC;
  ir["right"]  = s.irR;

  JsonObject ultrasonic = payload.createNestedObject("ultrasonic");
  ultrasonic["distance_cm"] = s.frontCm;
  ultrasonic["servo_angle_deg"] = s.servoAngle;
  ultrasonic["valid"] = s.frontValid;

  payload["obstacle"] = s.obstacle;
  if (s.fault) payload["fault"] = s.fault;
  else         payload["fault"] = nullptr;

  payload["uptime_s"] = millis() / 1000;
  payload["rssi"] = WiFi.RSSI();

  char buffer[768];
  serializeJson(doc, buffer);
  client.publish(topicTelemetry, buffer, false);

  ledBlinkUntil = millis() + 60;
}

bool seenCommand(const char* id) {
  for (uint8_t i = 0; i < 8; i++) if (recentIds[i] == id) return true;
  return false;
}
void rememberCommand(const char* id) {
  recentIds[recentHead] = id;
  recentHead = (recentHead + 1) % 8;
}

void mqttCallback(char* topic, byte* payload, unsigned int length) {
  if (length == 0 || length > 700) return;
  char message[length + 1];
  memcpy(message, payload, length);
  message[length] = '\0';
  Serial.printf("[COMMAND] %s: %s\n", topic, message);

  StaticJsonDocument<768> doc;
  if (deserializeJson(doc, message)) {
    Serial.println("[COMMAND] JSON parse error");
    return;
  }

  // Contract: commandId/type/expiresAtEpoch at top level (nested "payload" also tolerated)
  JsonVariant src = doc.as<JsonVariant>();
  if (doc["commandId"].isNull() && doc["payload"].is<JsonObject>()) src = doc["payload"];

  const char* commandId = src["commandId"] | "";
  const char* type      = src["type"] | "";
  double expiresAt      = src["expiresAtEpoch"] | 0.0;
  if (expiresAt > 100000000000.0) expiresAt /= 1000.0;   // tolerate milliseconds

  if (strlen(commandId) == 0) return;
  if (seenCommand(commandId)) return;                    // QoS1 duplicate delivery
  rememberCommand(commandId);

  if (expiresAt > 0 && timeIsValid() && (double)time(nullptr) > expiresAt) {
    publishCommandAck(commandId, "expired", "Command arrived past expiresAtEpoch");
    return;
  }

  if (strcmp(type, "PAUSE") == 0) {
    opMode = 1;
    motorsEnabled = false;
    publishCommandAck(commandId, "executed", "Trolley paused");
    publishStatus("online");
    publishTelemetry();
  }
  else if (strcmp(type, "RESUME") == 0) {
    bool obstacle;
    portENTER_CRITICAL(&snapMux);
    obstacle = snap.obstacle;
    portEXIT_CRITICAL(&snapMux);

    if (obstacle) {
      publishCommandAck(commandId, "rejected", "Obstacle in front, cannot resume safely");
    } else {
      opMode = 0;
      motorsEnabled = true;     // driving loop re-centres servo and restarts FOLLOW
      publishCommandAck(commandId, "executed", "Line following resumed");
      publishStatus("online");
      publishTelemetry();
    }
  }
  else if (strcmp(type, "STOP") == 0) {
    opMode = 2;
    motorsEnabled = false;
    publishCommandAck(commandId, "executed", "Emergency STOP executed");
    publishStatus("online");
    publishTelemetry();
  }
  else if (strcmp(type, "REQUEST_STATUS") == 0) {
    publishCommandAck(commandId, "executed", "Status refreshed on demand");
    publishStatus("online");
    publishTelemetry();
  }
  else {
    publishCommandAck(commandId, "rejected", "Unknown command");
  }
}

// One non-blocking MQTT connection attempt (called at most every MQTT_RETRY_MS).
void tryConnectMQTT() {
  Serial.print("[MQTT] Connecting to " + String(MQTT_BROKER) + "... ");
  char suffix[8];
  snprintf(suffix, sizeof(suffix), "%04X", (uint16_t)(ESP.getEfuseMac() & 0xFFFF));
  String clientId = "esp32-trolley-" + String(DEVICE_ID) + "-" + String(suffix);

  // Last Will & Testament (retained "offline" status)
  StaticJsonDocument<256> lwtDoc;
  lwtDoc["v"] = 1;
  lwtDoc["deviceId"] = DEVICE_ID;
  lwtDoc["ts"] = "1970-01-01T00:00:00.000Z";
  lwtDoc["type"] = "status";
  JsonObject lwtPayload = lwtDoc.createNestedObject("payload");
  lwtPayload["state"] = "offline";
  lwtPayload["fw"] = FW_VERSION;
  lwtPayload["ip"] = "0.0.0.0";
  lwtPayload["rssi"] = 0;
  lwtPayload["motorsEnabled"] = false;

  char lwtBuffer[256];
  serializeJson(lwtDoc, lwtBuffer);

  bool ok;
  if (strlen(MQTT_USER) > 0)
    ok = client.connect(clientId.c_str(), MQTT_USER, MQTT_PASS, topicStatus, 1, true, lwtBuffer);
  else
    ok = client.connect(clientId.c_str(), topicStatus, 1, true, lwtBuffer);

  if (ok) {
    Serial.println("CONNECTED!");
    client.subscribe(topicCommands, 1);
    publishStatus("online");
    if (!bootEventSent) {
      publishEvent("DEVICE_BOOT", "info", "ESP32 trolley connected to broker");
      bootEventSent = true;
    }
    publishTelemetry();
  } else {
    Serial.printf("FAILED (rc=%d)\n", client.state());
  }
}

void networkTask(void* arg) {
  WiFi.mode(WIFI_STA);
  WiFi.persistent(false);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.printf("[WIFI] Connecting to %s\n", WIFI_SSID);

  client.setServer(MQTT_BROKER, MQTT_PORT);
  client.setCallback(mqttCallback);
  client.setBufferSize(1024);
  client.setKeepAlive(15);
  client.setSocketTimeout(3);

  uint32_t lastWifiTry = millis();
  uint32_t lastMqttTry = 0;
  uint32_t lastTelemetry = 0;

  for (;;) {
    const uint32_t now = millis();

    if (WiFi.status() != WL_CONNECTED) {
      if (now - lastWifiTry >= WIFI_RETRY_MS) {
        lastWifiTry = now;
        Serial.println("[WIFI] Reconnecting...");
        WiFi.disconnect();
        WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
      }
    } else {
      if (!ntpStarted) {
        Serial.println("[WIFI] Connected, IP: " + WiFi.localIP().toString());
        configTime(0, 0, "pool.ntp.org", "time.nist.gov");   // UTC; SNTP keeps re-syncing
        ntpStarted = true;
      }

      // Valid UTC time is required for the server's clock-skew checks
      if (timeIsValid()) {
        if (!client.connected()) {
          if (now - lastMqttTry >= MQTT_RETRY_MS) {
            lastMqttTry = now;
            tryConnectMQTT();
          }
        } else {
          client.loop();

          uint8_t ev;
          while (xQueueReceive(eventQueue, &ev, 0) == pdTRUE) {
            if (ev == EVT_OBSTACLE)
              publishEvent("OBSTACLE_DETECTED", "warning",
                           "Obstacle in path, trolley stopped and re-routing");
          }

          if (now - lastTelemetry >= TELEMETRY_INTERVAL_MS) {
            lastTelemetry = now;
            publishTelemetry();
          }
        }
      }
    }

    // Status LED: solid = MQTT connected (short blink per telemetry), flashing = offline
    if (client.connected())
      digitalWrite(PIN_LED, ((int32_t)(now - ledBlinkUntil) >= 0) ? HIGH : LOW);
    else
      digitalWrite(PIN_LED, (now / 400) % 2);

    vTaskDelay(pdMS_TO_TICKS(5));
  }
}

// ============================ 6. DRIVING (CORE 1) ============================
enum State : uint8_t {
  ST_FOLLOW, ST_OBS_STOP,
  ST_SCAN_LEFT_MOVE, ST_SCAN_LEFT_READ,
  ST_SCAN_RIGHT_MOVE, ST_SCAN_RIGHT_READ,
  ST_SCAN_CENTER_MOVE, ST_DECIDE,
  ST_BYPASS_TURN_OUT, ST_BYPASS_SIDE, ST_BYPASS_TURN_PARALLEL,
  ST_BYPASS_PASS, ST_BYPASS_TURN_IN, ST_BYPASS_RETURN, ST_REALIGN,
  ST_BACKUP, ST_BLOCKED_WAIT
};

const char* const STATE_NAMES[] = {
  "FOLLOW", "OBS_STOP",
  "SCAN_L_MOVE", "SCAN_L_READ", "SCAN_R_MOVE", "SCAN_R_READ",
  "SCAN_C_MOVE", "DECIDE",
  "BYP_TURN_OUT", "BYP_SIDE", "BYP_TURN_PAR", "BYP_PASS", "BYP_TURN_IN",
  "BYP_RETURN", "REALIGN", "BACKUP", "BLOCKED_WAIT"
};

Servo scannerServo;

State    state = ST_FOLLOW;
State    stoppedFrom = ST_FOLLOW;
uint32_t stateEnterMs = 0;

int     bypassDir = -1;          // -1 = detour left, +1 = right
int     lastTurn = 1;
uint8_t avoidAttempts = 0;
float   leftCm = 0, rightCm = 0;

bool irL = false, irC = false, irR = false;

int      prevErr = 0;
uint32_t lastControlMs = 0;
uint32_t lostStartMs = 0;
uint32_t allSinceMs = 0;
uint32_t irSeenMs = 0;
bool     lineGaveUp = false;

int      servoAngle = -1;
uint32_t servoReadyMs = 0;

volatile uint32_t echoRiseUs = 0, echoFallUs = 0;
volatile bool echoRose = false, echoFell = false;
bool     sonarPending = false;
uint32_t sonarTrigUs = 0, sonarTrigMs = 0, lastTrigMs = 0;

float   frontBuf[3] = {NO_ECHO_CM, NO_ECHO_CM, NO_ECHO_CM};
uint8_t frontN = 0, frontIdx = 0;
float   frontCm = NO_ECHO_CM;
bool    frontValid = false;
bool    obstacleLatched = false;

float   scanBuf[SCAN_SAMPLES];
uint8_t scanCount = 0;

int curL = 0, curR = 0, tgtL = 0, tgtR = 0;
uint32_t lastMotorMs = 0;
uint32_t lastLogMs = 0;

bool     wasParked = false;
uint32_t buzzerUntil = 0;
uint32_t lastObstacleEvtMs = 0;
bool     prevObstacle = false;

// ---------------- MOTORS ----------------
void writeSide(int speed, uint8_t pinA, uint8_t pinB, bool inverted, float trim) {
  if (inverted) speed = -speed;
  const int mag = abs(speed);

  if (mag == 0) {
    ledcWrite(pinA, 0);
    ledcWrite(pinB, 0);
    return;
  }

  int duty = MOTOR_MIN_PWM + ((mag - 1) * (255 - MOTOR_MIN_PWM)) / 254;
  duty = constrain(static_cast<int>(duty * trim), 0, 255);

  if (speed > 0) {
    ledcWrite(pinA, duty);
    ledcWrite(pinB, 0);
  } else {
    ledcWrite(pinA, 0);
    ledcWrite(pinB, duty);
  }
}

void applyMotors() {
  writeSide(curL, LEFT_IN1, LEFT_IN2, INVERT_LEFT_MOTORS, LEFT_TRIM);
  writeSide(curR, RIGHT_IN1, RIGHT_IN2, INVERT_RIGHT_MOTORS, RIGHT_TRIM);
}

void drive(int l, int r) {
  tgtL = constrain(l, -255, 255);
  tgtR = constrain(r, -255, 255);
}

void stopNow() {
  tgtL = tgtR = curL = curR = 0;
  applyMotors();
}

int slew(int cur, int tgt) {
  if (cur == tgt) return cur;
  const bool magnitudeFalling = (cur > 0 && tgt < cur) || (cur < 0 && tgt > cur);
  const int step = magnitudeFalling ? RAMP_DOWN : RAMP_UP;
  if (tgt > cur) return min(cur + step, tgt);
  return max(cur - step, tgt);
}

void updateMotors(uint32_t now) {
  if (now - lastMotorMs < MOTOR_UPDATE_MS) return;
  lastMotorMs = now;
  curL = slew(curL, tgtL);
  curR = slew(curR, tgtR);
  applyMotors();
}

void pivot(int dir, int speed) {   // +1 = right, -1 = left
  drive(dir * speed, -dir * speed);
}

// ---------------- IR ----------------
bool readIR(uint8_t pin) {
  int hits = 0;
  for (int i = 0; i < 3; i++) {
    if (digitalRead(pin) == IR_DETECTED_LEVEL) hits++;
    delayMicroseconds(40);
  }
  return hits >= 2;
}

void readIRSensors() {
  irL = readIR(IR_LEFT);
  irC = readIR(IR_CENTER);
  irR = readIR(IR_RIGHT);
}

// ---------------- SONAR ----------------
void IRAM_ATTR onEcho() {
  if (gpio_get_level(static_cast<gpio_num_t>(ECHO_PIN))) {
    echoRiseUs = micros();
    echoRose = true;
  } else if (echoRose) {
    echoFallUs = micros();
    echoFell = true;
  }
}

bool sonarUpdate(float &outCm) {
  if (!sonarPending) {
    if (millis() - lastTrigMs >= SONAR_INTERVAL_MS) {
      noInterrupts();
      echoRose = false;
      echoFell = false;
      interrupts();

      digitalWrite(TRIG_PIN, LOW);
      delayMicroseconds(2);
      digitalWrite(TRIG_PIN, HIGH);
      delayMicroseconds(10);
      digitalWrite(TRIG_PIN, LOW);

      sonarTrigUs = micros();
      sonarTrigMs = lastTrigMs = millis();
      sonarPending = true;
    }
    return false;
  }

  if (echoFell) {
    noInterrupts();
    const uint32_t width = echoFallUs - echoRiseUs;
    interrupts();
    sonarPending = false;

    float cm = static_cast<float>(width) * 0.0343f / 2.0f;
    if (cm < 2.0f) cm = 2.0f;
    if (cm > 300.0f) cm = NO_ECHO_CM;
    outCm = cm;
    return true;
  }

  if (micros() - sonarTrigUs > SONAR_TIMEOUT_US) {
    sonarPending = false;
    outCm = NO_ECHO_CM;
    return true;
  }
  return false;
}

float median3(float a, float b, float c) {
  return fmaxf(fminf(a, b), fminf(fmaxf(a, b), c));
}

void resetFront() {
  frontN = 0;
  frontIdx = 0;
  frontValid = false;
  obstacleLatched = false;
}

void pushFront(float cm) {
  frontBuf[frontIdx] = cm;
  frontIdx = (frontIdx + 1) % 3;
  if (frontN < 3) frontN++;
  if (frontN >= 3) {
    frontCm = median3(frontBuf[0], frontBuf[1], frontBuf[2]);
    frontValid = true;
  }
}

void updateObstacleLatch() {
  if (!frontValid) return;
  if (frontCm <= OBSTACLE_STOP_CM) obstacleLatched = true;
  else if (frontCm >= OBSTACLE_RESUME_CM) obstacleLatched = false;
}

float scanMedian() {
  if (scanCount == 0) return 0.0f;
  float tmp[SCAN_SAMPLES];
  for (uint8_t i = 0; i < scanCount; i++) tmp[i] = scanBuf[i];
  for (uint8_t i = 0; i < scanCount; i++)
    for (uint8_t j = i + 1; j < scanCount; j++)
      if (tmp[j] < tmp[i]) { float t = tmp[i]; tmp[i] = tmp[j]; tmp[j] = t; }
  return tmp[scanCount / 2];
}

void setServo(int angle) {
  if (angle == servoAngle) return;
  scannerServo.write(angle);
  servoAngle = angle;
  servoReadyMs = millis() + SERVO_SETTLE_MS;
  resetFront();
}

void onSonarSample(float cm) {
  if (static_cast<int32_t>(sonarTrigMs - servoReadyMs) < 0) return;

  if (state == ST_SCAN_LEFT_READ || state == ST_SCAN_RIGHT_READ) {
    if (scanCount < SCAN_SAMPLES) scanBuf[scanCount++] = cm;
  } else if (servoAngle == SERVO_CENTER) {
    pushFront(cm);
  }
}

// ---------------- STATE MACHINE ----------------
void resetLineController() {
  prevErr = 0;
  lostStartMs = 0;
  allSinceMs = 0;
  lastControlMs = 0;
  lineGaveUp = false;
}

void setState(State s) {
  state = s;
  stateEnterMs = millis();

  switch (s) {
    case ST_FOLLOW:
      resetLineController();
      resetFront();
      break;
    case ST_OBS_STOP:
      stopNow();
      break;
    case ST_SCAN_LEFT_MOVE:
      stopNow();
      setServo(SERVO_LEFT_ANGLE);
      break;
    case ST_SCAN_RIGHT_MOVE:
      setServo(SERVO_RIGHT_ANGLE);
      break;
    case ST_SCAN_CENTER_MOVE:
      setServo(SERVO_CENTER);
      break;
    case ST_BYPASS_TURN_OUT:
      pivot(bypassDir, TURN_SPEED);
      break;
    case ST_BYPASS_SIDE:
    case ST_BYPASS_PASS:
      resetFront();
      drive(BYPASS_SPEED, BYPASS_SPEED);
      break;
    case ST_BYPASS_TURN_PARALLEL:
    case ST_BYPASS_TURN_IN:
      pivot(-bypassDir, TURN_SPEED);
      break;
    case ST_BYPASS_RETURN:
      resetFront();
      irSeenMs = 0;
      drive(BYPASS_SPEED, BYPASS_SPEED);
      break;
    case ST_REALIGN:
      pivot(bypassDir, REALIGN_SPEED);
      break;
    case ST_BACKUP:
      drive(-BACKUP_SPEED, -BACKUP_SPEED);
      break;
    case ST_BLOCKED_WAIT:
      stopNow();
      break;
    default:
      break;
  }
}

float slowScale(float d) {
  if (d >= SLOW_ZONE_CM) return 1.0f;
  float k = (d - OBSTACLE_STOP_CM) / (SLOW_ZONE_CM - OBSTACLE_STOP_CM);
  k = constrain(k, 0.0f, 1.0f);
  return MIN_SLOW_SCALE + (1.0f - MIN_SLOW_SCALE) * k;
}

void handleLostLine(uint32_t now, float scale) {
  if (lostStartMs == 0) lostStartMs = now;
  const uint32_t lost = now - lostStartMs;
  const uint32_t coast = (abs(prevErr) >= 1) ? 0 : LOST_COAST_MS;

  if (lost < coast) {
    drive(static_cast<int>(GENTLE_SPEED * scale), static_cast<int>(GENTLE_SPEED * scale));
  } else if (lost < coast + SEARCH_FIRST_MS) {
    pivot(lastTurn, SEARCH_SPEED);
  } else if (lost < coast + SEARCH_FIRST_MS + SEARCH_SECOND_MS) {
    pivot(-lastTurn, SEARCH_SPEED);
  } else {
    drive(0, 0);
    lineGaveUp = true;
  }
}

void followLine(uint32_t now) {
  if (!frontValid) {
    drive(0, 0);
    return;
  }

  const int count = irL + irC + irR;
  const float scale = slowScale(frontCm);

  if (count == 0) {
    handleLostLine(now, scale);
    return;
  }
  lostStartMs = 0;
  lineGaveUp = false;

  if (irL && irC && irR) {
    if (allSinceMs == 0) allSinceMs = now;
    if (now - allSinceMs > ALL_SENSORS_MAX_MS) {
      drive(0, 0);
      return;
    }
  } else {
    allSinceMs = 0;
  }

  if ((irL && irC && irR) || (irL && irR)) {
    const int v = static_cast<int>(GENTLE_SPEED * scale);
    drive(v, v);
    return;
  }

  int err;
  if (irL && irC)      err = -1;
  else if (irC && irR) err = 1;
  else if (irC)        err = 0;
  else if (irL)        err = -2;
  else                 err = 2;

  if (err != 0) lastTurn = (err < 0) ? -1 : 1;

  if (now - lastControlMs < CONTROL_PERIOD_MS) return;
  lastControlMs = now;

  if (abs(err) == 2) {
    const int outer = static_cast<int>(TURN_SPEED * scale);
    if (err < 0) drive(SHARP_INNER_SPEED, outer);
    else         drive(outer, SHARP_INNER_SPEED);
  } else {
    const float steer = KP * err + KD * (err - prevErr);
    const float base = (FORWARD_SPEED - CORNER_SLOWDOWN * abs(err)) * scale;
    drive(static_cast<int>(base + steer), static_cast<int>(base - steer));
  }
  prevErr = err;
}

void runState(uint32_t now) {
  const uint32_t t = now - stateEnterMs;

  // Safety layer: any forward motion is checked against the front sonar
  const bool forwardState = (state == ST_FOLLOW) || (state == ST_BYPASS_SIDE) ||
                            (state == ST_BYPASS_PASS) || (state == ST_BYPASS_RETURN);
  if (forwardState && frontValid) {
    updateObstacleLatch();
    if (obstacleLatched) {
      stopNow();
      stoppedFrom = state;
      if (state != ST_FOLLOW) {
        if (++avoidAttempts >= MAX_AVOID_ATTEMPTS) {
          setState(ST_BLOCKED_WAIT);
          return;
        }
      }
      setState(ST_OBS_STOP);
      return;
    }
  }

  switch (state) {
    case ST_FOLLOW:
      followLine(now);
      break;

    case ST_OBS_STOP:
      updateObstacleLatch();
      if (frontValid && !obstacleLatched) {
        setState(stoppedFrom);
      } else if (t >= OBS_WAIT_MS) {
        setState(ST_SCAN_LEFT_MOVE);
      }
      break;

    case ST_SCAN_LEFT_MOVE:
      if (now >= servoReadyMs) { scanCount = 0; setState(ST_SCAN_LEFT_READ); }
      break;
    case ST_SCAN_LEFT_READ:
      if (scanCount >= SCAN_SAMPLES || t > 1000) {
        leftCm = scanMedian();
        setState(ST_SCAN_RIGHT_MOVE);
      }
      break;
    case ST_SCAN_RIGHT_MOVE:
      if (now >= servoReadyMs) { scanCount = 0; setState(ST_SCAN_RIGHT_READ); }
      break;
    case ST_SCAN_RIGHT_READ:
      if (scanCount >= SCAN_SAMPLES || t > 1000) {
        rightCm = scanMedian();
        setState(ST_SCAN_CENTER_MOVE);
      }
      break;
    case ST_SCAN_CENTER_MOVE:
      if (now >= servoReadyMs) setState(ST_DECIDE);
      break;

    case ST_DECIDE: {
      if (!frontValid && t < 1000) break;
      updateObstacleLatch();
      Serial.printf("Scan -> Left: %.1f cm, Right: %.1f cm, Front: %.1f cm\n",
                    leftCm, rightCm, frontCm);

      if (frontValid && !obstacleLatched) {
        setState(stoppedFrom);
        break;
      }

      const bool leftClear  = leftCm  >= MIN_SIDE_CLEARANCE_CM;
      const bool rightClear = rightCm >= MIN_SIDE_CLEARANCE_CM;

      if (!leftClear && !rightClear) {
        Serial.println("No verified clear path.");
        if (++avoidAttempts >= MAX_AVOID_ATTEMPTS) setState(ST_BLOCKED_WAIT);
        else if (ENABLE_BACKUP) setState(ST_BACKUP);
        else setState(ST_OBS_STOP);
        break;
      }

      bypassDir = (leftClear && (!rightClear || leftCm >= rightCm)) ? -1 : 1;
      lastTurn = bypassDir;
      Serial.println(bypassDir < 0 ? "Detour: LEFT" : "Detour: RIGHT");
      setState(ST_BYPASS_TURN_OUT);
      break;
    }

    case ST_BYPASS_TURN_OUT:
      if (t >= TURN_90_MS) setState(ST_BYPASS_SIDE);
      break;
    case ST_BYPASS_SIDE:
      if (t >= BYPASS_SIDE_MS) setState(ST_BYPASS_TURN_PARALLEL);
      break;
    case ST_BYPASS_TURN_PARALLEL:
      if (t >= TURN_90_MS) setState(ST_BYPASS_PASS);
      break;
    case ST_BYPASS_PASS:
      if (t >= BYPASS_PASS_MS) setState(ST_BYPASS_TURN_IN);
      break;
    case ST_BYPASS_TURN_IN:
      if (t >= TURN_90_MS) setState(ST_BYPASS_RETURN);
      break;

    case ST_BYPASS_RETURN:
      if (irL || irC || irR) {
        if (irSeenMs == 0) irSeenMs = now;
        if (now - irSeenMs >= 30) setState(ST_REALIGN);
      } else {
        irSeenMs = 0;
      }
      if (t >= BYPASS_RETURN_MAX_MS) setState(ST_FOLLOW);
      break;

    case ST_REALIGN:
      if ((t >= REALIGN_MIN_MS && irC) || t >= REALIGN_MAX_MS) {
        avoidAttempts = 0;
        setState(ST_FOLLOW);
      }
      break;

    case ST_BACKUP:
      if (t >= BACKUP_MS) {
        stopNow();
        setState(ST_OBS_STOP);
      }
      break;

    case ST_BLOCKED_WAIT:
      if (t >= BLOCKED_RECHECK_MS) {
        avoidAttempts = 0;
        setState(ST_OBS_STOP);
      }
      break;
  }
}

// ---------------- SNAPSHOT / EVENTS / LOGGING ----------------
void updateSharedOutputs(uint32_t now) {
  // Buzzer (non-blocking beep)
  digitalWrite(PIN_BUZZER, ((int32_t)(buzzerUntil - now) > 0) ? HIGH : LOW);

  static uint32_t lastSnap = 0;
  if (now - lastSnap < 50) return;
  lastSnap = now;

  const bool inStopStates = (state == ST_OBS_STOP) ||
                            (state >= ST_SCAN_LEFT_MOVE && state <= ST_DECIDE) ||
                            (state == ST_BACKUP) || (state == ST_BLOCKED_WAIT);
  // While parked (PAUSE/STOP) the state machine is frozen, so rely on the live latch only
  const bool obstacle = obstacleLatched || (motorsEnabled && inStopStates);

  const char* fault = nullptr;
  if (ENABLE_FAULT_REPORTING && motorsEnabled) {
    if (state == ST_BLOCKED_WAIT) fault = "PATH_BLOCKED";
    else if (lineGaveUp)          fault = "LINE_LOST";
  }

  portENTER_CRITICAL(&snapMux);
  snap.irL = irL;
  snap.irC = irC;
  snap.irR = irR;
  snap.frontCm = frontCm;
  snap.frontValid = frontValid;
  snap.servoAngle = servoAngle;
  snap.obstacle = obstacle;
  snap.fault = fault;
  portEXIT_CRITICAL(&snapMux);

  // New obstacle -> beep + web-app event (rate limited)
  if (obstacle && !prevObstacle && (now - lastObstacleEvtMs > 3000 || lastObstacleEvtMs == 0)) {
    lastObstacleEvtMs = now;
    buzzerUntil = now + 80;
    uint8_t ev = EVT_OBSTACLE;
    xQueueSend(eventQueue, &ev, 0);
  }
  prevObstacle = obstacle;
}

const char* actionLabel() {
  if (abs(tgtL) < 5 && abs(tgtR) < 5) return "STOP";
  if (tgtL < 0 && tgtR < 0) return "BACK";
  if (tgtL > tgtR + 30) return "RIGHT";
  if (tgtR > tgtL + 30) return "LEFT";
  return "FORWARD";
}

void logTelemetry(uint32_t now) {
  if (now - lastLogMs < LOG_INTERVAL_MS) return;
  lastLogMs = now;
  Serial.printf("DATA,%d,%d,%d,%.1f,%s,%s\n",
                irL, irC, irR, frontCm, actionLabel(),
                motorsEnabled ? STATE_NAMES[state] : MODE_NAMES[opMode]);
}

// ============================ 7. SETUP / LOOP ============================
void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("\n=== AVCOE ESP32 SMART TROLLEY (merged firmware) ===");

  pinMode(PIN_LED, OUTPUT);
  pinMode(PIN_BUZZER, OUTPUT);
  digitalWrite(PIN_BUZZER, LOW);

  pinMode(IR_LEFT, INPUT);
  pinMode(IR_CENTER, INPUT);
  pinMode(IR_RIGHT, INPUT);

  pinMode(TRIG_PIN, OUTPUT);
  digitalWrite(TRIG_PIN, LOW);
  pinMode(ECHO_PIN, INPUT);

  const uint8_t motorPins[] = {LEFT_IN1, LEFT_IN2, RIGHT_IN1, RIGHT_IN2};
  for (uint8_t pin : motorPins) {
    pinMode(pin, OUTPUT);
    digitalWrite(pin, LOW);
  }

  snprintf(topicTelemetry,  sizeof(topicTelemetry),  "%s/devices/%s/telemetry",   TOPIC_PREFIX, DEVICE_ID);
  snprintf(topicStatus,     sizeof(topicStatus),     "%s/devices/%s/status",      TOPIC_PREFIX, DEVICE_ID);
  snprintf(topicCommandAck, sizeof(topicCommandAck), "%s/devices/%s/command-ack", TOPIC_PREFIX, DEVICE_ID);
  snprintf(topicEvents,     sizeof(topicEvents),     "%s/devices/%s/events",      TOPIC_PREFIX, DEVICE_ID);
  snprintf(topicCommands,   sizeof(topicCommands),   "%s/devices/%s/commands",    TOPIC_PREFIX, DEVICE_ID);

  eventQueue = xQueueCreate(8, sizeof(uint8_t));

  // Network runs on core 0 so it can never stall the motors on core 1
  xTaskCreatePinnedToCore(networkTask, "net", 8192, nullptr, 1, nullptr, 0);

  // Attach motor PWM first, then the servo (avoids LEDC channel/timer clashes)
  const bool ok = ledcAttach(LEFT_IN1, MOTOR_PWM_FREQ, PWM_BITS) &&
                  ledcAttach(LEFT_IN2, MOTOR_PWM_FREQ, PWM_BITS) &&
                  ledcAttach(RIGHT_IN1, MOTOR_PWM_FREQ, PWM_BITS) &&
                  ledcAttach(RIGHT_IN2, MOTOR_PWM_FREQ, PWM_BITS);
  if (!ok) {
    Serial.println("ERROR: Motor PWM initialization failed.");
    while (true) delay(1000);
  }
  stopNow();

  scannerServo.setPeriodHertz(50);
  scannerServo.attach(SERVO_PIN, 500, 2400);

  attachInterrupt(digitalPinToInterrupt(ECHO_PIN), onEcho, CHANGE);

  // Servo self-test (motors are off)
  scannerServo.write(SERVO_CENTER); delay(400);
  scannerServo.write(SERVO_LEFT_ANGLE); delay(500);
  scannerServo.write(SERVO_RIGHT_ANGLE); delay(700);
  scannerServo.write(SERVO_CENTER); delay(500);
  servoAngle = SERVO_CENTER;
  servoReadyMs = millis();

  Serial.println("Trolley ready. Starting in 2 s - place it on the track.");
  delay(2000);

  setState(ST_FOLLOW);
}

void loop() {
  const uint32_t now = millis();

  float cm;
  if (sonarUpdate(cm)) onSonarSample(cm);

  readIRSensors();

  if (!motorsEnabled) {
    // PAUSED / STOPPED from the web app: hold still, keep sensing so RESUME can be validated
    if (!wasParked) {
      stopNow();
      wasParked = true;
    }
    setServo(SERVO_CENTER);
    updateObstacleLatch();
  } else {
    if (wasParked) {                 // RESUME received: restart cleanly
      wasParked = false;
      avoidAttempts = 0;
      setServo(SERVO_CENTER);
      setState(ST_FOLLOW);
    }
    runState(now);
    updateMotors(now);
  }

  updateSharedOutputs(now);
  logTelemetry(now);
}

#include <ESP8266WiFi.h>
#include <U8g2lib.h>

// ==========================================
// [1] 와이파이 & 서버 설정
// ==========================================
const char* ssid     = "test";          // 핫스팟 이름
const char* password = "34993499";      // 핫스팟 비밀번호

const char* host     = "192.168.199.122";
const uint16_t port  = 5000;            // Node.js 서버 포트

// ==========================================
// [2] OLED 및 전역 변수 설정
// ==========================================
U8G2_SSD1306_128X64_NONAME_F_SW_I2C u8g2(U8G2_R0, 12, 14, U8X8_PIN_NONE);
int currentPwm = 0;
WiFiClient client;
unsigned long lastSendTime = 0; // 데이터 전송 주기 체크용

void setup() {
  Serial.begin(115200);

  //내장 LED 핀 설정
  pinMode(LED_BUILTIN, OUTPUT);     
  digitalWrite(LED_BUILTIN, HIGH);  // 초기 상태: 꺼짐 (Active Low라 HIGH가 OFF)

  // OLED 초기화
  u8g2.begin();
  u8g2.enableUTF8Print();
  u8g2.setFont(u8g2_font_6x12_tr);

  // 1. 와이파이 연결 시도
  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
  delay(100);

  Serial.println();
  Serial.print("Connecting to: ");
  Serial.println(ssid);
  WiFi.begin(ssid, password);

  // 연결 대기 루프
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
    
    // OLED 표시
    u8g2.clearBuffer();
    u8g2.drawStr(0, 10, "WiFi Connecting...");
    u8g2.drawStr(0, 30, ssid);
    u8g2.sendBuffer();
  }

  Serial.println("\n✅ WiFi Connected!");
  Serial.print("IP: ");
  Serial.println(WiFi.localIP());

  // 연결 성공 화면
  u8g2.clearBuffer();
  u8g2.drawStr(0, 10, "WiFi OK!");
  u8g2.setCursor(0, 30);
  u8g2.print(WiFi.localIP());
  u8g2.sendBuffer();
  delay(1000);
}

void loop() {
  if (!client.connected()) {
    if (client.connect(host, port)) Serial.println("✅ Server Connected!");
    else { delay(1000); return; }
  }

  // [수신] 서버 -> 아두이노
  if (client.available()) {
    String msg = client.readStringUntil('\n');
    msg.trim(); 
    
    if (msg.length() > 0) {
      Serial.println("Recv: [" + msg + "]"); 

      if (msg == "LED_ON") digitalWrite(LED_BUILTIN, LOW); 
      else if (msg == "LED_OFF") digitalWrite(LED_BUILTIN, HIGH);
      
      // PWM 명령 받기
      else if (msg.startsWith("PWM:")) {
         currentPwm = msg.substring(4).toInt(); 
         Serial.print("👉 PWM 설정됨: ");
         Serial.println(currentPwm);
      }
    }
  }

  // [송신] 아두이노 -> 서버 (0.2초마다)
  unsigned long currentTime = millis();
  if (currentTime - lastSendTime > 200) { 
    lastSendTime = currentTime;

    long rssi = WiFi.RSSI(); 
    
    // RPM 계산 (PWM에 비례 + 노이즈)
    int baseRpm = currentPwm * 30;
    int noise = (currentPwm > 0) ? random(-50, 51) : 0;
    int currentRpm = baseRpm + noise;
    if (currentRpm < 0) currentRpm = 0;

    // RSSI와 RPM만 보냄 (PWM은 서버가 이미 알고 있음)
    String dataToSend = "RSSI:" + String(rssi) + ",RPM:" + String(currentRpm);
    client.println(dataToSend);
  }
}
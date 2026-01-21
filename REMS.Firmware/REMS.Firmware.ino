#include <ESP8266WiFi.h>
#include <U8g2lib.h>

// ==========================================
// [1] 와이파이 & 서버 설정
// ==========================================
const char* ssid     = "test";          // 핫스팟 이름
const char* password = "34993499";      // 핫스팟 비밀번호

const char* host     = "10.75.221.122"; 
const uint16_t port  = 5000;            // Node.js 서버 포트

// ==========================================
// [2] OLED 및 전역 변수 설정
// ==========================================
U8G2_SSD1306_128X64_NONAME_F_SW_I2C u8g2(U8G2_R0, 12, 14, U8X8_PIN_NONE);
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
  // 2. 서버 연결 상태 확인 및 재연결
  if (!client.connected()) {
    Serial.print("Connecting to Server: ");
    Serial.println(host);

    // 서버 연결 시도
    if (client.connect(host, port)) {
      Serial.println("✅ Server Connected!");
    } else {
      Serial.println("❌ Connection Failed. Retrying...");
      delay(2000);
      return; // 연결 실패하면 loop 처음으로 돌아감
    }
  }

  // 3. 데이터 수신 (서버 -> ESP8266)
  if (client.available()) {
    String msg = client.readStringUntil('\n');
    
    msg.trim(); // 앞뒤 공백, 줄바꿈 문자(\r, \n) 완전 제거
    Serial.println("Recv: [" + msg + "]"); // 대괄호[]로 감싸서 공백이 있는지 확인

    // [추가] LED 제어 로직
    if (msg == "LED_ON") {
      digitalWrite(LED_BUILTIN, LOW); 
      Serial.println("💡 LED turned ON");
    } 
    else if (msg == "LED_OFF") {
      digitalWrite(LED_BUILTIN, HIGH); 
      Serial.println("🌑 LED turned OFF");
    }

    // OLED에 받은 메시지 표시
    u8g2.clearBuffer();
    u8g2.drawStr(0, 10, "Server Msg:");
    u8g2.setCursor(0, 25);
    u8g2.print(msg);
    u8g2.sendBuffer();
  }

  // 4. 데이터 송신 (ESP8266 -> Server)
  unsigned long currentTime = millis();
  if (currentTime - lastSendTime > 200) { //0.2초마다 송신
    lastSendTime = currentTime;

    // 현재 RSSI(신호 강도) 측정
    long rssi = WiFi.RSSI(); 
    
    // 서버로 전송할 메시지 포맷: "RSSI:-65"
    String dataToSend = "RSSI:" + String(rssi);
    client.println(dataToSend);
    
    Serial.println("Send: " + dataToSend);
  }
}
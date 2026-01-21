#include <ESP8266WiFi.h>
#include <U8g2lib.h>

// ==========================================
// [사용자 설정] 와이파이 정보 입력
// ==========================================
const char* ssid     = "test";      // 예: "SK_WiFiGIGA"
const char* password = "34993499";  // 예: "12345678"

// ==========================================
// [OLED 설정] 핀 번호 (Clock=12, Data=14)
// ==========================================
// SW I2C 방식: (Rotation, Clock, Data, Reset)
U8G2_SSD1306_128X64_NONAME_F_SW_I2C u8g2(U8G2_R0, 12, 14, U8X8_PIN_NONE);

void setup() {
  Serial.begin(115200); // 시(속도 115200)
  
  // 1. OLED 초기화
  u8g2.begin();
  u8g2.enableUTF8Print(); // 한글 출력 대비
  
  // 2. 와이파이 연결 시작
  WiFi.begin(ssid, password);

  Serial.println();
  Serial.print("와이파이 연결 시도 중: ");
  Serial.println(ssid);

  // 3. 연결 대기 (연결될 때까지 무한 루프)
  int dotCount = 0;
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print("."); 

    // OLED에 "Connecting..." 표시
    u8g2.clearBuffer();
    u8g2.setFont(u8g2_font_7x14B_tr); // 제목 폰트
    u8g2.drawStr(0, 15, "WiFi Connecting");
    
    // 점이 늘어나는 애니메이션
    String dots = "";
    for(int i=0; i<=dotCount%10; i++) dots += ".";
    u8g2.drawStr(0, 35, dots.c_str());
    
    u8g2.sendBuffer();
    dotCount++;
  }

  // 4. 연결 성공 시 실행
  Serial.println("");
  Serial.println("✅ 와이파이 연결 성공!");
  Serial.print("할당받은 IP 주소: ");
  Serial.println(WiFi.localIP());

  // OLED에 성공 메시지와 IP 주소 출력
  u8g2.clearBuffer();
  u8g2.setFont(u8g2_font_7x14B_tr);
  u8g2.drawStr(0, 15, "WiFi Connected!");
  
  u8g2.setFont(u8g2_font_6x12_tr); 
  u8g2.setCursor(0, 35);
  u8g2.print("IP: ");
  u8g2.print(WiFi.localIP()); // IP 주소 출력
  
  u8g2.sendBuffer();
}

void loop() {
  // 연결이 완료되었으므로 여기서는 아무것도 안 하고 대기
  // 나중에 여기에 '서버 접속 코드'를 넣을 예정
}
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using LiveChartsCore;
using LiveChartsCore.SkiaSharpView;
using LiveChartsCore.SkiaSharpView.Painting;
using SkiaSharp;
using System;
using System.Collections.Generic; // List용
using System.Collections.ObjectModel;
using System.IO;
using System.Net.Http;          // REST API 통신용
using System.Net.Sockets;       // 소켓 통신용
using System.Text.Json;         // JSON 파싱용
using System.Threading.Tasks;   // 비동기 작업용
using System.Windows;           // UI 업데이트용

namespace REMS.Client
{
    // DB 데이터 한 줄을 저장할 모델 클래스
    public class LogDataModel
    {
        public int Id { get; set; }
        public string Timestamp { get; set; }
        public string IpAddress { get; set; }
        public int Rssi { get; set; }
        public int Rpm { get; set; }
        public string Status { get; set; }
    }

    public partial class MainViewModel : ObservableObject
    {
        // ==========================================
        // [1] 차트 및 UI 데이터 설정
        // ==========================================
        private readonly ObservableCollection<double> _rssiValues;
        private readonly ObservableCollection<double> _rpmValues;

        public ISeries[] RssiSeries { get; set; }
        public ISeries[] RpmSeries { get; set; }
        public Axis[] XAxes { get; set; }

        // ==========================================
        // [2] 상태 데이터
        // ==========================================
        [ObservableProperty] private string _ipAddress = "127.0.0.1"; // TCP 연결 IP
        [ObservableProperty] private int _port = 5000;                // TCP 연결 Port
        [ObservableProperty] private bool _isConnected = false;

        [ObservableProperty] private bool _isLedOn;
        [ObservableProperty] private string _logText = "";

        [ObservableProperty] private int _wifiRssi = -100;
        [ObservableProperty] private int _currentRpm = 0;

        [ObservableProperty] private int _motorSpeed = 0;
        private bool _isServerUpdate = false;


        // ==========================================
        // [New] DB 검색용 데이터
        // ==========================================
        [ObservableProperty] private DateTime _searchStartDate = DateTime.Now.AddDays(-1); // 어제
        [ObservableProperty] private DateTime _searchEndDate = DateTime.Now;               // 오늘

        [ObservableProperty] private int _searchResultCount = 0; // 검색 결과 개수

        [ObservableProperty] private int _startHour = 0;
        [ObservableProperty] private int _startMinute = 0;
        [ObservableProperty] private int _endHour = 23;
        [ObservableProperty] private int _endMinute = 59;

        public List<int> Hours { get; } = Enumerable.Range(0, 24).ToList();
        public List<int> Minutes { get; } = Enumerable.Range(0, 60).ToList();

        // DataGrid에 바인딩 될 컬렉션
        public ObservableCollection<LogDataModel> SearchResults { get; } = new ObservableCollection<LogDataModel>();

        // Node.js API 포트 (TCP와 다름, 보통 3000 사용)
        private const int ApiPort = 3000;

        // ==========================================
        // [3] 통신용 변수
        // ==========================================
        private TcpClient _client;
        private StreamReader _reader;
        private StreamWriter _writer;

        // [추가] HTTP 클라이언트 (재사용 권장)
        private static readonly HttpClient _httpClient = new HttpClient();

        // ==========================================
        // [4] 생성자 (초기화)
        // ==========================================
        public MainViewModel()
        {
            _rssiValues = new ObservableCollection<double>();
            _rpmValues = new ObservableCollection<double>();

            for (int i = 0; i < 30; i++)
            {
                _rssiValues.Add(-100);
                _rpmValues.Add(0);
            }

            RssiSeries = new ISeries[]
            {
                new LineSeries<double>
                {
                    Values = _rssiValues,
                    Fill = null,
                    GeometrySize = 0,
                    Stroke = new SolidColorPaint(SKColors.DeepSkyBlue) { StrokeThickness = 2 },
                    Name = "Wi-Fi RSSI (dBm)"
                }
            };

            RpmSeries = new ISeries[]
            {
                new LineSeries<double>
                {
                    Values = _rpmValues,
                    Fill = new SolidColorPaint(SKColors.Orange.WithAlpha(50)),
                    GeometrySize = 0,
                    Stroke = new SolidColorPaint(SKColors.Orange) { StrokeThickness = 2 },
                    Name = "Actual RPM"
                }
            };

            XAxes = new Axis[]
            {
                new Axis {
                  NamePaint = new SolidColorPaint(SKColors.Gray),
                  LabelsPaint = new SolidColorPaint(SKColors.Gray),
                  TextSize = 11,
                  Labeler = v => DateTime.Now.AddSeconds(v - 30).ToString("HH:mm:ss")
                  }
            };

            AddLog("[SYS] 클라이언트가 시작되었습니다.");
        }

        // ==========================================
        // [5] Commands (버튼 이벤트 핸들러)
        // ==========================================

        // ------------------------------------------
        // [New] DB 검색 커맨드
        // ------------------------------------------
        [RelayCommand]
        public async Task SearchDb()
        {
            try
            {
                // 1. URL 생성 (Node.js 서버 주소)
                string start = $"{SearchStartDate:yyyy-MM-dd} {StartHour:D2}:{StartMinute:D2}:00";
                string end = $"{SearchEndDate:yyyy-MM-dd} {EndHour:D2}:{EndMinute:D2}:59";
                string url = $"http://{IpAddress}:{ApiPort}/api/logs?start={Uri.EscapeDataString(start)}&end={Uri.EscapeDataString(end)}";

                AddLog($"[DB] 검색 시작:{start} ~ {end}");

                // 2. GET 요청 전송
                var response = await _httpClient.GetAsync(url);
                response.EnsureSuccessStatusCode(); // 200 OK 아닐 시 예외 발생

                // 3. JSON 응답 읽기
                string jsonString = await response.Content.ReadAsStringAsync();

                // 4. JSON -> 객체 리스트 변환 (대소문자 무시 옵션)
                var options = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };
                var data = JsonSerializer.Deserialize<List<LogDataModel>>(jsonString, options);

                // 5. UI 업데이트 
                SearchResults.Clear();
                if (data != null)
                {
                    foreach (var item in data) SearchResults.Add(item);
                    SearchResultCount = data.Count;
                    AddLog($"[DB] {data.Count}건 조회 완료.");
                }
            }

            catch (HttpRequestException httpEx)
            {
                AddLog($"[DB] ❌ 통신 오류: API 서버({ApiPort})에 연결할 수 없습니다.");
                MessageBox.Show("API 서버 연결 실패.\nNode.js 서버가 실행 중인지 확인하세요.", "Error", MessageBoxButton.OK, MessageBoxImage.Error);
            }
            catch (Exception ex)
            {
                AddLog($"[DB] ❌ 검색 실패: {ex.Message}");
            }
        }

        // ------------------------------------------
        // TCP 및 제어 커맨드
        // ------------------------------------------
        [RelayCommand]
        public async Task Connect()
        {
            if (IsConnected) return;

            try
            {
                AddLog($"[NET] 서버({IpAddress}:{Port}) 연결 시도 중...");

                _client = new TcpClient();
                await _client.ConnectAsync(IpAddress, Port);

                _reader = new StreamReader(_client.GetStream());
                _writer = new StreamWriter(_client.GetStream()) { AutoFlush = true };

                IsConnected = true;
                AddLog("[NET] ✅ 서버 연결 성공!");

                _ = ReceiveDataLoop();
            }
            catch (Exception ex)
            {
                AddLog($"[NET] ❌ 연결 실패: {ex.Message}");
                IsConnected = false;
            }
        }

        [RelayCommand]
        public void TurnLedOn()
        {
            if (!IsLedOn)
            {
                IsLedOn = true;
                SendCommand("LED_ON");
            }
        }

        [RelayCommand]
        public void TurnLedOff()
        {
            if (IsLedOn)
            {
                IsLedOn = false;
                SendCommand("LED_OFF");
            }
        }

        [RelayCommand]
        public void RunMotor()
        {
            SendCommand("MOTOR_RUN");
        }

        [RelayCommand]
        public void PauseMotor()
        {
            SendCommand("EMERGENCY_STOP");
            MotorSpeed = 0;
            TurnLedOff();
        }

        [RelayCommand]
        public void AutoStart()
        {
            SendCommand("AUTO_START");
            AddLog("[SYS] 자동 공정 시퀀스 시작 명령을 전송했습니다.");
        }

        // ==========================================
        // [6] 데이터 송수신
        // ==========================================
        private async Task ReceiveDataLoop()
        {
            try
            {
                while (IsConnected)
                {
                    string message = await _reader.ReadLineAsync();
                    if (message == null) break;

                    Application.Current.Dispatcher.Invoke(() =>
                    {
                        if (message.StartsWith("LOG:"))
                        {
                            string logContent = message.Substring(4);
                            AddLog(logContent);
                        }
                        else
                        {
                            ParseAndVisualize(message);
                        }
                    });
                }
            }
            catch (Exception)
            {
                Application.Current.Dispatcher.Invoke(() => AddLog("[NET] ❌ 서버 연결 끊김"));
            }
            finally
            {
                _client?.Close();
                IsConnected = false;
            }
        }

        private void ParseAndVisualize(string rawData)
        {
            try
            {
                var parts = rawData.Split(',');
                foreach (var part in parts)
                {
                    var keyValue = part.Split(':');
                    if (keyValue.Length != 2) continue;

                    string key = keyValue[0];
                    double value = double.Parse(keyValue[1]);

                    if (key == "RSSI")
                    {
                        if (_rssiValues.Count > 30) _rssiValues.RemoveAt(0);
                        _rssiValues.Add(value);
                        WifiRssi = (int)value;
                    }
                    else if (key == "RPM")
                    {
                        if (_rpmValues.Count > 30) _rpmValues.RemoveAt(0);
                        _rpmValues.Add(value);
                        CurrentRpm = (int)value;
                    }
                    else if (key == "PWM")
                    {
                        _isServerUpdate = true;
                        MotorSpeed = (int)value;
                        _isServerUpdate = false;
                    }
                }
            }
            catch
            {
                // 파싱 에러 무시
            }
        }

        public void SendCommand(string command)
        {
            if (IsConnected && _writer != null)
            {
                try
                {
                    _writer.WriteLine(command);
                    AddLog($"[TX] 명령 전송: {command}");
                }
                catch
                {
                    IsConnected = false;
                }
            }
        }

        partial void OnMotorSpeedChanged(int value)
        {
            if (_isServerUpdate) return;
            SendCommand($"PWM:{value}");
        }

        private void AddLog(string msg)
        {
            string time = DateTime.Now.ToString("HH:mm:ss");
            LogText = $"[{time}] {msg}\n" + LogText;
        }
    }
}
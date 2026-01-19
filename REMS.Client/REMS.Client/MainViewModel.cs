using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using LiveChartsCore;
using LiveChartsCore.SkiaSharpView;
using LiveChartsCore.SkiaSharpView.Painting;
using SkiaSharp;
using System;
using System.Collections.ObjectModel;
using System.IO;
using System.Net.Sockets;       // 소켓 통신용
using System.Threading.Tasks;   // 비동기 작업용
using System.Windows;           // UI 업데이트용

namespace REMS.Client
{
    public partial class MainViewModel : ObservableObject
    {
        // [1] 차트 데이터
        private readonly ObservableCollection<double> _tempValues;
        public ISeries[] TempSeries { get; set; }

        private readonly ObservableCollection<double> _motorValues;
        public ISeries[] MotorSeries { get; set; }

        // [2] 상태 데이터
        [ObservableProperty]
        private bool _isLedOn;

        [ObservableProperty]
        private int _motorSpeed = 50;

        [ObservableProperty]
        private string _logText = "";

        // [3] 통신용 변수
        private TcpClient _client;
        private StreamReader _reader;
        private StreamWriter _writer;

        [ObservableProperty]
        private bool _isConnected = false;

        public MainViewModel()
        {

            _tempValues = new ObservableCollection<double>();
            _motorValues = new ObservableCollection<double>();

            // 차트가 비어있으면 에러가 나니까, 0으로 채워진 빈 데이터를 미리 30개 정도 넣어둠
            for (int i = 0; i < 30; i++) { _tempValues.Add(0); _motorValues.Add(0); }

            TempSeries = new ISeries[]
            {
                new LineSeries<double>
                {
                    Values = _tempValues,
                    Fill = new SolidColorPaint(SKColors.Cyan.WithAlpha(50)),
                    GeometrySize = 0,
                    Stroke = new SolidColorPaint(SKColors.Cyan) { StrokeThickness = 3 },
                    Name = "Temperature"
                }
            };

            MotorSeries = new ISeries[]
            {
                new StepLineSeries<double>
                {
                    Values = _motorValues,
                    Fill = new SolidColorPaint(SKColors.Orange.WithAlpha(50)),
                    GeometrySize = 0,
                    Stroke = new SolidColorPaint(SKColors.Orange) { StrokeThickness = 3 },
                    Name = "Motor Output"
                }
            };
            AddLog("[SYS] REMS 클라이언트 시작됨");
            AddLog("[SYS] 모니터링 시스템 대기 중...");
        }

        // [4] 서버 연결 함수
        public async void ConnectToServer(string ip, int port)
        {
            if (IsConnected) return; // 이미 연결됐으면 패스

            try
            {
                AddLog($"[NET] 서버({ip}:{port}) 연결 시도...");

                _client = new TcpClient();
                await _client.ConnectAsync(ip, port); // 비동기 연결 시도

                _reader = new StreamReader(_client.GetStream());
                _writer = new StreamWriter(_client.GetStream()) { AutoFlush = true };
                IsConnected = true;

                AddLog("[NET] ✅ 서버 연결 성공!");

                // 연결되자마자 데이터 수신 시작 (별도 스레드)
                _ = Task.Run(ReceiveDataLoop);
            }
            catch (Exception ex)
            {
                AddLog($"[NET] ❌ 서버 연결 실패: {ex.Message}");
            }
        }

        // [5] 데이터 수신 루프
        private async Task ReceiveDataLoop()
        {
            try
            {
                while (IsConnected)
                {
                    // 서버가 보낸 한 줄 읽기 ("TEMP:24.5,MOTOR:80")
                    string message = await _reader.ReadLineAsync();
                    if (message == null) break;

                    // UI 업데이트는 메인 스레드에서 해야 함! (중요)
                    Application.Current.Dispatcher.Invoke(() =>
                    {
                        ParseAndVisualize(message); //데이터 해석기 호출
                    });
                }
            }
            catch (Exception ex)
            {
                Application.Current.Dispatcher.Invoke(() => AddLog("[NET] ❌ 서버 연결 실패"));
            }
            finally
            {
                _client?.Close();
                IsConnected = false;
            }
        }

        // [6] 데이터 해석기 (Parsing)
        private void ParseAndVisualize(string rawData)
        {
            // rawData 예시: "TEMP:24.5,MOTOR:80"
            try
            {
                var parts = rawData.Split(','); // 쉼표로 자름
                foreach (var part in parts)
                {
                    var keyValue = part.Split(':'); // 콜론으로 자름
                    string key = keyValue[0];       // "TEMP"
                    double value = double.Parse(keyValue[1]); // 24.5

                    if (key == "TEMP")
                    {
                        // 그래프 업데이트 (오래된 거 지우고 새거 추가)
                        _tempValues.RemoveAt(0);
                        _tempValues.Add(value); //꺼낸 숫자를 _tempValues.Add(value)로 리스트에 넣으면 -> 자동으로 그래프가 그려짐
                    }
                    else if (key == "MOTOR")
                    {
                        _motorValues.RemoveAt(0);
                        _motorValues.Add(value);
                    }
                }
            }
            catch
            {
                // 데이터가 깨져서 오면 무시
            }
        }

        // [7] 서버로 명령 보내기 (LED, MOTOR 제어)
        public void SendCommand(string command)
        {
            if (IsConnected && _writer != null)
            {
                _writer.WriteLine(command); // 서버로 전송!
                AddLog($"[TX] 명령 전송: {command}");
            }
        }

        // LED ON/OFF UI
        [RelayCommand]
        public void TurnLedOn()
        {
            if (!IsLedOn) 
            {
                IsLedOn = true;         // UI에 빨간불 켜기
                SendCommand("LED_ON");  // 서버 전송
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

        // MOTOR UI
        partial void OnMotorSpeedChanged(int value)
        {
            // 슬라이더를 움직이면 "PWM:50" 같은 형식으로 서버에 전송
            SendCommand($"PWM:{value}");
        }

        [RelayCommand]
        public void RunMotor()
        {
            SendCommand("MOTOR_RUN");
        }

        [RelayCommand]
        public void PauseMotor()
        {
            SendCommand("MOTOR_PAUSE"); 
        }

        [RelayCommand]
        public void EmergencyStop()
        {
            SendCommand("EMERGENCY_STOP");
            MotorSpeed = 0; // 속도도 0으로 초기화
            TurnLedOff();
        }

        // 로그 추가 헬퍼
        private void AddLog(string msg)
        {
            string time = DateTime.Now.ToString("HH:mm:ss");
            LogText = $"[{time}] {msg}\n" + LogText; // 최신 로그가 위로 오게
        }
    }
}
using System.Windows;

namespace REMS.Client
{
    public partial class MainWindow : Window
    {
        private MainViewModel _viewModel;

        public MainWindow()
        {
            InitializeComponent();
            _viewModel = new MainViewModel();
            this.DataContext = _viewModel;
        }


        private void BtnConnect_Click(object sender, RoutedEventArgs e)
        {
            _viewModel.ConnectToServer("127.0.0.1", 5000);
        }

        private void BtnLed_Click(object sender, RoutedEventArgs e)
        {
            _viewModel.ToggleLed();
        }
    }
}
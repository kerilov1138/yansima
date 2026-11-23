@echo off
echo Yansima tek dosya (.exe) derleniyor...
pip install -r requirements.txt pyinstaller
pyinstaller --noconfirm --onefile --windowed --name "Yansima" ^
  --add-data "web;web" ^
  --hidden-import "bottle_websocket" ^
  --hidden-import "paho.mqtt.client" ^
  main.py
echo.
echo Derleme tamamlandi! Dosya: dist\Yansima.exe
pause

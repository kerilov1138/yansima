# Yansıma — WebRTC Uzak Masaüstü (0 TL / Açık Kaynak)

Yansıma; iki farklı PC arasında veya **telefon/tablet tarayıcısından PC'ye** farklı Wi-Fi ve mobil ağlar (4G/5G) üzerinden bağlanabilen, tek seferlik davet linkiyle çalışan ücretsiz uzak masaüstü uygulamasıdır.

## Özellikler
- **Farklı Ağlarda Çalışır:** Google ücretsiz STUN sunucuları ve WebRTC (DTLS-SRTP şifreli) ile port açmaya veya SSH tüneline gerek kalmaz.
- **Telefon / Tablet Desteği:** Karşı taraf hiçbir uygulama indirmeden **GitHub Pages** üzerinden açılan web linkiyle PC'yi dokunmatik + sanal klavye ile yönetebilir.
- **Tek Seferlik Güvenli Link:** Her oturumda rastgele tek kullanımlık şifre (token) üretilir; oturum bitince eski link geçersiz olur.

## Kurulum ve Çalıştırma (Geliştirici / Yerel)
```bash
pip install -r requirements.txt
python main.py
```

## GitHub + GitHub Pages ile Ücretsiz Yayınlama
1. Bu klasörü GitHub'da yeni bir depoya (repository) yükleyin.
2. GitHub depo ayarlarından **Settings -> Pages** bölümüne girin ve `web/` klasörünü (veya `docs/` olarak kopyalayıp) yayınlayın.
   - Oluşan URL örneği: `https://kullaniciadiniz.github.io/yansima/`
3. Masaüstü uygulamasını açtığınızda **"GitHub Pages URL"** kutusuna bu adresi bir kez yapıştırın (otomatik kaydedilir).
4. Tek tıkla `.exe` üretmek için `build_exe.bat` dosyasını çalıştırın ve `dist/Yansima.exe` dosyasını **GitHub Releases** üzerinden paylaşın.

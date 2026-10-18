# Güvenlik

Tewecik Guard, Discord izin modeli içinde çalışan bir savunma aracıdır. Sunucu sahibinin hesabının veya bot tokenının ele geçirilmesine, botun üzerindeki rollere ya da Discord hizmet kesintilerine karşı mutlak koruma sağlamaz.

## Açık bildirimi

Bir güvenlik açığını herkese açık issue üzerinden paylaşmayın. Depoda GitHub'ın **Security → Report a vulnerability** seçeneği etkinse özel bildirim özelliğini kullanın. Bu seçenek yoksa, açık ayrıntılarını paylaşmadan depo sahibinden özel bir iletişim kanalı isteyin.

Bildirime etkilenen sürümü, etkiyi ve kişisel veri içermeyen yeniden üretim adımlarını ekleyin. Gerçek tokenlar, yedek anahtarları veya kullanıcı verileri göndermeyin.

## Dağıtım

- Önce gözlem modunu ve ayrı bir test sunucusunu kullanın.
- Bot tokenını ve `BACKUP_KEY` değerini kaynak koddan ayrı saklayın.
- Veri dizininin erişimini servis hesabıyla sınırlayın.
- Anahtarları yedeklerden ayrı tutun; kurtarma prosedürünü düzenli doğrulayın.
- Bağımlılık ve Node.js güncellemelerini test ederek uygulayın.

Yerel testlerin geçmesi, canlı Discord izinlerinin ve recovery işlemlerinin her sunucuda sorunsuz çalışacağını garanti etmez. Desteklenen özellikler ve sınırlar [README](README.md) içinde açıklanmıştır.

# Katkıda bulunma

Tewecik Guard'a katkılarınızı bekliyoruz. Hata bildirimlerinde gözlenen davranışı, beklenen sonucu, Node.js sürümünü ve sorunu yeniden üretmek için gereken adımları belirtin.

## Geliştirme

```sh
npm ci
npm test
npm run check
```

Değişikliklerinizi ayrı bir dalda hazırlayın. Pull request açıklamasında çözülen sorunu, davranış değişikliğini ve doğrulama sonuçlarını belirtin. Kurulum veya yapılandırma değişiyorsa README'yi güncelleyin.

Koruma kararları, yetkilendirme, kuyruk ve recovery değişikliklerinde ilgili hata senaryolarını test edin. Gerçek Discord işlemlerini yalnızca ayrı bir test sunucusunda doğrulayın. Kullanıcıya görünen mesajlar Türkçe ve açık olmalıdır.

## Gizlilik

Token, `.env`, yedek anahtarı, gerçek sunucu logları veya kişisel veriler içeren dosyaları issue ve pull request'lere eklemeyin. Örnekleri anonimleştirin.

Güvenlik açıkları için [güvenlik bildirim sürecini](SECURITY.md) kullanın. Tartışmalarda konuya odaklanan, saygılı ve yapıcı bir dil tercih edin.

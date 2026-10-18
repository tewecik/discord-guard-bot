# Tewecik Guard

**Discord sunucuları için yapılandırılabilir koruma ve kontrollü kurtarma.**

Tewecik Guard, tek Discord sunucusu için Node.js ve TypeScript tabanlı bir güvenlik botudur. Türkçe slash komutları, işlem bazlı güven izinleri, kalıcı olay/kuyruk kayıtları ve AES-256-GCM ile şifreli yapı yedekleri içerir.

[Kurulum](#kurulum) · [Korumalar](#uygulanan-korumalar) · [Komutlar](#komutlar) · [Recovery](#yedekleme-ve-recovery) · [İşletim](#işletim-ve-dosyalar) · [Katkıda bulunma](CONTRIBUTING.md) · [Güvenlik](SECURITY.md).

İlk açılış **gözlem modundadır**. Otomatik rol kaldırma, ban, timeout veya mesaj silme yapmaz. `/guard mode deger:enforce` komutunu ve onay düğmesini kullanarak otomatik müdahaleyi açın. Manuel lockdown ve recovery komutları gözlem modunda da açık onaydan sonra uygulanır.

## Sürümler

18 Ekim 2026 tarihinde doğrulanan ve bu projede kullanılan sürümler:

| Bileşen | Sürüm |
| --- | --- |
| Node.js | **26.12.0 Current** |
| discord.js | **14.27.0** |
| TypeScript | **5.9.3** |
| Zod | **4.6.7** |
| Node.js tipleri | **26.6.5** |
| Discord REST API | **v10** |
| Veritabanı | Node.js `node:sqlite`, WAL |

Paketler ve geçişli bağımlılıklar `package-lock.json` ile sabitlenmiştir. Kurulumda `npm ci` kullanın. Güncellemede lock dosyasını değiştirip testleri yeniden çalıştırın. Node.js 26 Current sürümüdür; LTS olduğu iddia edilmez.

Bu uygulama tek sunucu ve tek çalışan süreç için hazırlanmıştır. PostgreSQL, Redis veya ayrı kuyruk sunucusu gerektirmez. Birden fazla sunucuya hizmet veren genel bot, çoklu replika ve dağıtık koordinasyon bu sürümün kapsamı dışındadır. Aynı veritabanını birden fazla bot sürecine açmayın.

## Uygulanan korumalar

| Modül | İzlenen işlemler |
| --- | --- |
| `channels` | Kanal/kategori oluşturma, düzenleme, silme ve izin overwrite değişiklikleri |
| `roles` | Rol oluşturma, düzenleme, silme; üye rol değişiklikleri |
| `permissions` | Role tehlikeli izin ekleme, tehlikeli rol atama, kanal overwrite üzerinden tehlikeli izin verme |
| `members` | Kick, toplu üye temizleme (prune), ban, unban |
| `bots` | Sunucuya bot ekleme |
| `webhooks` | Webhook oluşturma, düzenleme, silme |
| `guild` | Sunucu ayar değişiklikleri |
| `assets` | Emoji, sticker ve planlanmış etkinlik oluşturma/düzenleme/silme |
| `automod` | AutoMod kuralı oluşturma, düzenleme, silme |
| `threads` | Thread oluşturma, düzenleme, silme |

- İşlemler doğrudan Discord audit log kaydındaki fail, hedef ve işlem türünden alınır. Son audit kaydının failini tahmin ederek ceza uygulanmaz.
- Aynı audit kimliği yeniden işlendiğinde ikinci yaptırım oluşturulmaz.
- En fazla 60 saniyelik audit olayları otomatik değerlendirilir. Eski veya faili bilinmeyen olaylar cezalandırılmaz; kayda geçer.
- Başlangıçta ve Gateway resume sonrasında son 100 audit kaydı taranır. Bu sayı aşıldığında boşluk olabileceği raporlanır. Bot kapalıyken tüm olayları yakalama garantisi yoktur.
- Her modülün işlem eşiği ve ağırlığı vardır. Farklı modüllerdeki işlemler aynı kullanıcının birleşik puanına eklenir.
- Toplu üye temizleme (prune), `members` modülü etkinse tek olayda birleşik eşiği doldurur.
- Varsayılan pencere 30 saniye, birleşik eşik 8 puandır. `permissions`, `bots`, `guild` ve `automod` tek olayda tetiklenir. Diğer modüllerin gerçek varsayılanları `/guard config` çıktısındadır.
- Tekrar eden fail müdahaleleri 30 saniye boyunca birleştirilir. Yeni yetki yükseltmeleri ve bot/webhook işlemleri ayrıca işlenir.
- Guard eşiğinin altında kalan tekil işlemler otomatik olarak geri alınmaz.
- `strip` müdahalesi failin tehlikeli izin taşıyan, düzenlenebilir rollerini tek tek kaldırır. Diğer roller korunur. Yönetilen veya hiyerarşi nedeniyle kaldırılamayan roller olay kaydında belirtilir.
- `ban` müdahalesi ayrıca onaylanır; başarısız işlemler sessizce başarılı sayılmaz.
- Yetki saldırılarında, fail müdahalesine ek olarak yeni verilen tehlikeli rol/izin geri alınmaya çalışılır. Rol ve overwrite izinlerinde gözlenen son değer değişmişse işlem çakışma olarak kaydedilir.
- Eşiği tetikleyen izinsiz bot ekleme işleminde bot çıkarılır. Webhook oluşturma/düzenlemede ilgili webhook silinir. Webhook silme işlemi geri oluşturulmaz.
- API hız sınırlarını discord.js yönetir. Otomatik müdahale işleri, yedek ve recovery kuyruğundan ayrı yürür. Başarısız uygun işler sınırlı üstel gecikmeyle tekrar denenir.
- Otomatik yaptırımlar iki dakika sonra bayatlar. Mod gözleme alınmışsa veya ilgili kullanıcıya kapsamlı güven izni verilmişse bekleyen yaptırımlar uygulanmaz.

### Raid

Katılım hızı ve yeni hesap oranı birlikte değerlendirilir. Varsayılan: 15 saniyede 10 katılım, en az %60'ı 72 saatten genç hesap. Tetiklenince 10 dakikalık raid penceresi açılır. Aktif müdahale modunda bu penceredeki genç, timeout uygulanabilir hesaplara geçici timeout verilir. Eski hesaplar yalnızca katıldıkları için cezalandırılmaz. Bot katılımları ayrı audit modülündedir.

Raid penceresi diskte tutulur; kayan katılım ve mesaj sayaçları bellektedir ve yeniden başlatmada sıfırlanır. `/guard raidclear` pencereyi kapatır, verilmiş timeout sürelerini kaldırmaz.

### Spam

Kullanıcı ve webhook bazlı flood; aynı mesaj tekrarları; mention ve everyone/here saldırıları; isteğe bağlı davet bağlantısı engeli; tam alan adı ve alt alan adı denylist; dosya uzantısı politikası.

Varsayılanlar: 6 saniyede 7 mesaj, 4 tekrar, 6 mention, 10 dakika timeout. Tetikleyen mesaj silinir; geçmiş mesajların tamamı taranıp silinmez. Webhook spaminde webhook kaldırılabilir. Normal bot mesajları spam filtresinden muaftır.

Flood, Message Content Intent olmadan çalışır. Tekrar, alan adı, davet ve dosya içeriğine bağlı kurallar için `MESSAGE_CONTENT_ENABLED=true` ve Developer Portal'da Message Content Intent gerekir. İçerik kapalıyken tüm mention verilerinin sağlanacağı varsayılmaz. İçerik saklanmaz; tekrar kontrolünde kısa ömürlü SHA-256 özeti tutulur. Ekler indirilmez veya çalıştırılmaz. Uzantı kontrolü antivirüs değildir; alan adı kontrolü URL yönlendirmelerini çözmez.

## Kurulum

### 1. Node.js

[Resmî indirme sayfasından](https://nodejs.org/en/download) Node.js **26.12.0** kurun. Yeni terminal açıp doğrulayın:

```sh
node --version
npm --version
```

Node sürümü `v26.12.0` olmalıdır. Projedeki `.nvmrc` aynı sürümü belirtir.

Projeyi indirin:

```sh
git clone https://github.com/tewecik/discord-guard-bot.git
cd discord-guard-bot
```

### 2. Discord uygulaması

1. [Discord Developer Portal](https://discord.com/developers/applications) üzerinden uygulama ve bot oluşturun.
2. Bot tokenını alın. Tokenı kaynak koda, Discord mesajına veya sürüm kontrolüne koymayın.
3. **Server Members Intent** açın. Mesaj içeriği kuralları için ayrıca **Message Content Intent** açın. Gereken intent erişimleri uygulamanın Discord onay durumuna bağlıdır.
4. Kurulum scopes: `bot`, `applications.commands`.
5. Bot için sunucu genelinde `View Audit Log`, `Manage Roles`, `Manage Channels`, `Manage Webhooks`, `Kick Members`, `Ban Members`, `Moderate Members`, `Manage Messages`, `View Channels`, `Send Messages`, `Embed Links`, `Attach Files`, `Read Message History` izinlerini ayarlayın. Temel sunucu ayarlarını recovery ile geri yüklemek için `Manage Server` da gerekir. Botun `Administrator` olması zorunlu değildir.
6. Botun rolünü yönetmesini istediğiniz tüm rollerin üzerine taşıyın. Rol hiyerarşisi Administrator izni verilerek aşılamaz.
7. Discord geliştirici modundan uygulama, sunucu ve gerekiyorsa yönetici kullanıcı kimliklerini kopyalayın.

### 3. Ortam dosyası

Windows PowerShell:

```powershell
Copy-Item .env.example .env
npm ci
npm run keygen
```

Linux/macOS:

```sh
cp .env.example .env
npm ci
npm run keygen
chmod 600 .env
```

Üretilen anahtarı `.env` içindeki `BACKUP_KEY` alanına yazın. Bu anahtarı yedeklerden ayrı ve güvenli saklayın. Anahtar kaybolursa şifreli yedekler açılamaz. Eski yedekler dururken anahtarı değiştirmeyin; bu sürüm çok anahtarlı dönüşümü otomatik yapmaz.

| Değişken | Açıklama |
| --- | --- |
| `DISCORD_TOKEN` | Bot tokenı |
| `APPLICATION_ID` | Uygulamanın kimliği |
| `GUILD_ID` | Korunacak tek sunucunun kimliği |
| `OWNER_IDS` | Virgülle ayrılmış ek güvenilir yönetici kullanıcı kimlikleri; boş bırakılabilir |
| `BACKUP_KEY` | `npm run keygen` çıktısı olan 32 bayt base64 anahtar |
| `DATA_DIR` | Varsayılan `./data` |
| `HEALTH_PORT` | Varsayılan `3100`; yalnızca `127.0.0.1` üzerinde dinlenir |
| `MESSAGE_CONTENT_ENABLED` | `true` veya `false`; Portal ayarıyla uyumlu olmalı |

Sunucu sahibi ve `OWNER_IDS` kullanıcıları kontrol düzlemidir ve guard yaptırımlarından muaftır. Bu hesapların ele geçirilmesine karşı bot koruma sağlayamaz. Genel Administrator izni tek başına bot ayarlarını değiştirme yetkisi vermez. Ek yöneticilerin slash komutlarına erişimini Discord uygulama komut izinlerinden de açmanız gerekebilir.

### 4. Derleme, kayıt ve başlangıç

```sh
npm test
npm run register
npm start
```

`npm test` derlemeyi de yapar. Sonraki kaynak değişikliklerinde `npm run build` gerekir. Komut şeması değiştiğinde `npm run register` tekrar çalıştırılır; aynı uygulamadaki diğer komutlar silinmez.

### 5. Sunucu içi ayarlar

1. `/guard setup kanal:#guard-log`.
2. `/guard doctor` ile izin ve hiyerarşi raporunu okuyun.
3. `/guard config` ile gerçek yapılandırmayı dışa aktarın.
4. Eşikleri düzenleyip `/guard config dosya:<json>` ile içe alın ve onaylayın.
5. Normal yönetim işlemleri için süreli `/guard trust` izinleri tanımlayın.
6. `/guard backup` ardından `/guard backups` ile ilk yedeği doğrulayın.
7. Gözlem olaylarını inceleyip `/guard mode deger:enforce` ve onay düğmesiyle müdahaleyi açın.

`config.example.json` içe aktarılabilir bir örnektir; başlangıçta otomatik okunmaz. Kalıcı gerçek ayarlar SQLite içindedir. Yapılandırma içe aktarımı tüm ayarları değiştirir; kısmi bir JSON patch değildir. Bilinmeyen alanlar ve geçersiz değerler reddedilir.

## Komutlar

| Komut | İşlev |
| --- | --- |
| `/guard setup` | Log kanalını doğrular ve kaydeder |
| `/guard status` | Mod, yaptırım, kuyruk, raid, kilit ve yedek durumunu verir |
| `/guard doctor` | İzin/hiyerarşi durumunu raporlar |
| `/guard mode` | Gözlem/aktif müdahale |
| `/guard policy` | Modül, limit, ağırlık, etkinlik |
| `/guard action` | Tehlikeli rolleri kaldır veya ban |
| `/guard trust` | Hesap/rol + kapsam + hedef + süre izinleri |
| `/guard untrust` | Hesabın/rolün tüm güven kayıtlarını kaldırır |
| `/guard trusts` | Etkin güven kayıtlarını listeler |
| `/guard lockchannels` | Kilitlenecek kanal kimliklerini belirler |
| `/guard lockdown` | Kilidi etkinleştirir/kaldırır; onaylı |
| `/guard backup` | Şifreli yapı yedeği |
| `/guard backups` | Son 25 yedeğin kimlikleri |
| `/guard restore` | Önizleme, kapsam seçimi ve onaylı recovery |
| `/guard incident` | Olay UUID'si veya son 25 olay |
| `/guard config` | JSON dışa/içe aktarım |
| `/guard raidclear` | Raid penceresini kapatır |

Örnek sınırlı bakım izni: `/guard trust hesap:<kullanıcı_kimliği> kapsam:channels dakika:15 hedef:<kategori_kimliği>`. Hedef belirtilmezse ilgili kapsamın tüm hedefleri geçerlidir. `kapsam:*` tüm modüllere izin verir; dar kapsamı tercih edin. Silinmiş kanalın üst kategori bilgisi cache'te yoksa kategori kapsamlı istisna eşleşmeyebilir; kritik bakımda kanal kimliğine açık izin kullanın.

Komut cevapları kişiye özel gönderilir. JSON dosyaları ayarların ve olayların tam kaydını sağlar. Önemli olaylar yapılandırılan log kanalına olay kimliğiyle bildirilir. Log kanalı silinirse yerel kayıtlar korunur.

## Lockdown davranışı

Seçilen kanallarda yalnızca `@everyone` için mesaj gönderme, thread oluşturma/yazma ve reaksiyon izinlerini kapatır. Var olan overwrite'ın önceki ve uygulanmış değerleri işlem öncesinde diske yazılır.

Kilit kaldırılırken değerler hâlâ botun bıraktığı durumdaysa geri alınır. Bir yönetici arada izinleri değiştirmişse bot bu değişikliği ezmez; `conflict` raporlar. Çakışmayı olay kaydındaki önceki/uygulanmış izinlerle karşılaştırarak elle çözün, ardından kilit kaldırmayı yeniden çalıştırın.

Bu bir tüm-sunucu susturma garantisi değildir. Administrator, özel rol ve üye overwrite izinleri kilidi aşabilir. Acil duruma uygun kanal izinlerini önceden test edin. Lockdown rol izinlerini topluca sıfırlamaz.

## Yedekleme ve recovery

- Varsayılan her 60 dakikada yedek, son 48 yedek saklama.
- AES-256-GCM, her yedekte ayrı 96 bit nonce ve doğrulama etiketi; ek SHA-256 dosya bütünlük kontrolü.
- Önce geçici dosyaya yazılır, ardından atomik yeniden adlandırılır.
- Recovery başlamadan mevcut durum ayrıca yedeklenir. Hedef yedek bu sırada saklama temizliğinden korunur.
- `roles`: yönetilebilen rollerin isim, tek renk, hoist, mentionable, izin ve konumları.
- `channels`: eksik normal roller; kategori/kanal isim, tür, üst kategori, konum, topic, NSFW, yavaş mod, ses bitrate/limit ve overwrite izinleri.
- `all`: bunlara ek sunucu adı, doğrulama seviyesi, açık içerik filtresi ve varsayılan bildirim düzeyi.
- Önce roller, sonra kategoriler, ardından kanallar işlenir. Eski/yeni kimlik eşleştirmesi SQLite'ta tutulur.
- Yeni varlık oluşturmadan önce işaret yazılır. Süreç yarıda kesilirse audit nedeninden oluşturulan varlık bulunmaya çalışılır. Doğrulanamayan oluşturma körlemesine tekrarlanmaz; işlem durdurulup raporlanır.
- Her recovery işi kendi kontrol noktalarını taşır. Aynı iş yeniden başlatmada devam eder; sonradan aynı yedeğe yeni bir restore komutu verilirse yeni çalışma başlar.
- Botun kendi audit işlemleri guard tarafından cezalandırılmaz.
- Fazladan var olan roller/kanallar silinmez. Yedekteki mevcut yapı ve izinler geri yükleme kapsamına göre değiştirilir.

### Recovery sınırları

Silinen roller ve kanallar eski Discord kimliğiyle geri gelmez. Eski mesaj bağlantıları, entegrasyon referansları ve dış sistem yapılandırmaları yeni kimliklere göre ayrıca düzeltilmelidir.

Üye-rol atamaları, mesajlar, thread içerikleri, forum etiketleri/varsayılan forum düzeni, rol ikonları/renk gradyanları, sunucu ikon/banner dosyaları, emojiler, sticker dosyaları, etkinlikler, AutoMod kural içerikleri, webhook tokenları, davetler ve ban listesi bu sürümün recovery kapsamına dahil değildir. Bu varlıkların audit koruması bulunması, tam yedeğinin bulunduğu anlamına gelmez. Yönetilen entegrasyon rolleri yeniden oluşturulmaz. Hiyerarşi nedeniyle atlanan roller veya sunucuda bulunmayan üye overwrite'ları kısmi sonuçta belirtilir.

Sunucudan çıkarılan kişi zorla geri getirilemez. Silinen mesaj özgün kimliği, yazarı ve zaman damgasıyla restore edilemez. Sunucu sahibi ve botun üzerindeki roller için Discord sınırları geçerlidir. Yapısal silme olaylarında otomatik toplu restore yapılmaz; fail durdurulur, uygun yedek yönetici tarafından önizlenip seçilir.

Bir backup snapshot'ı Discord üzerinde atomik değildir; API okumaları sırasında yapılan eşzamanlı değişiklikler farklı anlara ait olabilir. Bakım öncesi bilinen iyi yedek alın. Sunucu hâlâ saldırı altındayken restore başlatmayın; saldırı sürüyorsa yeni izin değişiklikleri recovery ile çakışabilir.

## İşletim ve dosyalar

```text
src/                 TypeScript uygulama
test/                Otomatik doğrulamalar
deploy/              systemd servis dosyası
data/guard.sqlite    Ayarlar, olaylar, güven kayıtları, kuyruk, recovery eşleştirmeleri
data/backups/        Şifreli .vgb yedekler
data/logs/           Günlük JSONL kayıtları
data/process.lock    Tek süreç denetimi
```

`data/` dizinini kalıcı diskte tutun. SQLite olay/log verileri disk üzerinde şifrelenmez; yedek dosyaları şifrelenir. Dosya erişimlerini servis hesabıyla sınırlayın. Windows'ta dosya ACL'lerini ayrıca düzenleyin. Loglar kullanıcı/kanal kimliği ve işlem metadatası içerir; mesaj gövdeleri tutulmaz. Varsayılan olay ve günlük saklama 30 gündür. Token ve anahtar log çıktısında maskelenir.

Veri dizinini başka makineye taşırken botu durdurun, SQLite ile birlikte tüm dizini ve ayrıca anahtarı güvenli şekilde taşıyın. Çalışan WAL veritabanının yalnızca `.sqlite` dosyasını kopyalamak tutarlı yedek sağlamaz.

Canlılık denetimi:

```sh
curl http://127.0.0.1:3100/healthz
```

Discord bağlantısı ve başlangıç kurulumu hazırsa `200`, aksi hâlde `503`. Bu uç tüm Discord izinlerinin sürekli geçerli olduğunu kanıtlamaz. Bot tamamen kapalıyken kendi arızasını Discord'a bildiremez; bağımsız bir izleme servisi kullanın.

### Docker Compose

`.env` dosyasını doldurup:

```sh
docker compose build
docker compose run --rm guard node dist/src/register.js
docker compose up -d
docker compose logs -f guard
```

Veri named volume içinde kalır. Container root olarak çalışmaz. Compose kendiliğinden komut kaydetmez. Docker healthcheck yalnızca container içinde çalışır; dışarıya port açılmaz. `unhealthy` durumu tek başına Docker'ın container'ı yeniden başlatmasını sağlamaz; yeniden başlatma ilkesi süreç çıkışına uygulanır. `docker compose down -v` veriyi siler; rutin durdurmada `-v` kullanmayın.

### Linux systemd

`deploy/tewecik-guard.service` dosyasında çalışma dizinini ve Node.js yolunu kendi kurulumunuza göre düzenleyin. Örnek kurulum:

```sh
sudo useradd --system --home /opt/tewecik-guard --shell /usr/sbin/nologin tewecik-guard
sudo mkdir -p /opt/tewecik-guard/data
sudo chown -R tewecik-guard:tewecik-guard /opt/tewecik-guard
sudo chmod 600 /opt/tewecik-guard/.env
sudo cp deploy/tewecik-guard.service /etc/systemd/system/tewecik-guard.service
sudo systemctl daemon-reload
sudo systemctl enable --now tewecik-guard
sudo journalctl -u tewecik-guard -f
```

Önce projeyi `/opt/tewecik-guard` altına kopyalayın, bağımlılıkları kurun, derleyin ve komutları kaydedin. Servis örneği Node.js'in `/usr/local/bin/node` altında olduğunu varsayar; `command -v node` sonucuyla düzeltin. Windows kurulumunda `npm start` terminal açıkken çalışır; Docker Desktop seçeneği yeniden başlatma yönetimi sağlar.

## Doğrulama ve bilinen kapsam

```sh
npm test
npm run check
```

Testler gerçek Discord değişikliği yapmaz. Şifre doğrulama ve bozulmuş yedek reddi; rol izinlerinin BigInt işlemleri; farklı modüllerin birleşik eşiği; güven kapsamı ve süresi; kuyruk yeniden başlatma ve öncelikleri; yinelenen/eski/faili bilinmeyen audit olayları; gözlem modu; yetki geri alma kuyruğu; içeriksiz flood; kilit kaldırmada yönetici değişikliğinin korunması; komut erişim sınırı doğrulanır.

Yerel doğrulama sonucu: **Node.js 26.12.0 üzerinde TypeScript derlemesi başarılı; 21 test geçti, 0 test başarısız.** Kurulum anındaki npm bağımlılık taraması 0 bilinen güvenlik açığı bildirdi. Bu sonuç canlı Discord entegrasyon testi yerine geçmez.

Bu çalışma sırasında gerçek Discord tokenı/sunucusu sağlanmadığından canlı Gateway bağlantısı, gerçek rol sırası, Discord REST yaptırımları ve sunucu üzerinde recovery uçtan uca doğrulanmadı. Önce ayrı bir test sunucusunda düşük riskli kanallar ve test rollerinde deneyin. Docker/systemd dosyaları sağlanmıştır; bu ortamda Docker veya Linux servisi çalıştırılmadı.

Web paneli, CAPTCHA/OAuth doğrulama akışı, haricî tehdit istihbaratı, tam dosya/mesaj arşivi, merkezi çok sunuculu yönetim ve dağıtık yüksek erişilebilirlik bu sürümde yoktur. Yapılandırma ve raporlar slash komutları üzerinden yönetilir.

## Sorun giderme

| Durum | Kontrol |
| --- | --- |
| `401` / login hatası | Token ve Application ID; token yenilendiyse `.env` ve servis yeniden başlatma |
| `4014` Gateway kapanışı | Developer Portal intent ayarları ve uygulamanın intent erişimi |
| `Missing Permissions` | Bot rol sırası, sunucu ve kanal izinleri; `/guard doctor` |
| Komut görünmüyor | `npm run register`, doğru Guild ID, uygulama komut izinleri |
| Guard yalnızca kayıt tutuyor | İlk mod `observe`; aktif moda onayla geçin |
| Ayar dosyası değişti ama uygulanmadı | `config.example.json` otomatik okunmaz; `/guard config dosya:` kullanın |
| Yedek açılamıyor | Aynı `BACKUP_KEY`, doğru sunucu ve bozulmamış yedek dosyası |
| Recovery durdu | `/guard incident` ve yerel JSONL; izin/rol hiyerarşisi veya belirsiz oluşturma kaydı |
| `process.lock` hatası | Önce eski sürecin gerçekten durduğunu doğrulayın; dosyayı çalışan bot varken silmeyin |
| Log kanalı sessiz | Kanal erişimi, Embed Links izni ve failed kuyruk kayıtları |

## Resmî kaynaklar

- [Node.js sürümleri](https://nodejs.org/en/download).
- [discord.js belgeleri](https://discord.js.org/docs/packages/discord.js/14.27.0).
- [Discord audit log yapısı](https://docs.discord.com/developers/resources/audit-log).
- [Discord izin modeli](https://docs.discord.com/developers/topics/permissions).
- [Discord hız sınırları](https://docs.discord.com/developers/topics/rate-limits).

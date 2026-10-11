# Kalıcı Gossipcat–Codex köprüsü

Bu ilk sürüm mevcut `codex exec` worker'ına disk üzerinde bir görev kuyruğu ve oturum sürdürme ekler. Codex App Server'a henüz geçilmedi. Her proje/ajan çifti ayrı bir kalıcı Codex oturumu kullanır; Desktop'ta açık olan bu sohbet otomatik uyandırılmaz.

## Akış

```text
Claude Code → gossip_dispatch → yerel Unix socket → kalıcı kuyruk
                                                     ↓
                                               codex exec / resume
                                                     ↓
Claude Code ← gossip_collect  ← disk üzerindeki terminal sonuç
```

Köprü otomatik olarak yeni işi alır, çalıştırır ve worker'ın bekleyen `gossip_collect` akışına sonucu döndürür. Görevler seri çalışır. Aynı ajan için takip görevi aynı Codex oturumunu sürdürür; farklı ajanlar farklı oturumlar kullanır. Model `gpt-6.1-sol`, sandbox salt okunur ve onay politikası `never` olarak sabittir.

## Kurulum

```sh
cd /Users/goku/Desktop/gossip
npm run build:all
npm run build:mcp
python3 scripts/codex-bridge-service.py install
python3 scripts/codex-bridge-service.py start
python3 scripts/codex-bridge-service.py status
```

Claude Code içinde `/mcp` üzerinden Gossipcat bağlantısını yeniden başlatın. Çalışan görevleri tamamlamadan MCP'yi yeniden başlatmayın. Mevcut ajan yapılandırması korunur; önceden eklenen `codex-sol` kullanılmaya devam eder. Codex Desktop'ın kendi daemon'ı durdurulmaz veya yeniden yapılandırılmaz.

Servis `launchd` altında oturum açılışında başlar ve süreç kapanırsa yeniden başlatılır. HTTP yalnızca Unix socket üzerinde taşınır; TCP portu açılmaz. Socket, SHA-256 ile proje yolundan türetilen kısa bir adla `/tmp/gossipcat-codex-<uid>/` altındadır. Klasör 0700, socket ve görev dosyaları 0600 izinlerine sahiptir. `enabled` işareti varken servis ulaşılamazsa worker açık hata verir; başka CLI çalıştırarak görevi çoğaltmaz.

## MCP araçları

```text
gossip_dispatch(mode:"single", agent_id:"codex-sol", task:"Modülü incele; dosya:satır referansı ver.")
gossip_collect(task_ids:["dönen görev kimliği"], timeout_ms:120000, consensus:false)

gossip_codex_bridge(action:"status")
gossip_codex_bridge(action:"collect", task_id:"dönen görev kimliği")
gossip_codex_bridge(action:"cancel", task_id:"dönen görev kimliği")
```

`gossip_codex_bridge(action:"collect")` tüm kalıcı kayıtları döndürür. MCP bağlantısı kesilmiş olsa bile tamamlanan sonuçlar bu araçla geri alınabilir. MCP'nin normal görev belleği yeniden bağlantıda kaybolabildiğinden, eski görev kimliklerinin sonuçlarını bu kurtarma aracıyla okuyun. Mevcut bekleyen worker bağlantısı açıksa sonuç otomatik normal collect'e döner.

## Yeniden başlatma ve iptal

- Kabul edilmiş görev, çalıştırılmadan önce diske atomik olarak yazılır ve fsync edilir.
- Aynı görev kimliği ve aynı içerik kayıtlı işi döndürür; yeni çalışma başlatmaz. Farklı içerikle aynı kimlik reddedilir.
- Tamamlanmış sonuçlar yeniden başlatmada korunur. Sırada bekleyen işler yeniden başlatma sonrası devam eder.
- Çalışırken kesilen işler başarısız olarak işaretlenir ve **otomatik tekrar çalıştırılmaz**. Sonucun tamamlanıp tamamlanmadığının bilinmediği durumda tek sefer garantisi iddia edilmez.
- Kaydedilmiş süreç kimliği ve başlama zamanı hâlâ aynı süreci gösteriyorsa, yeniden başlatmada eski Codex süreç grubu sonlandırılır.
- İptal ve collect zaman aşımı daemon'a iletilir; geç gelen sonuç iptal edilmiş görevin üzerine yazılamaz.
- MCP worker kapanışı daemon'daki işi iptal etmeden bağlantıyı bırakır; sonuç kalıcı kuyruğa yazılır. Servisi durdurmak o anda çalışan işi başarısız yapar, bekleyen işleri korur.

`.gossip/codex-bridge/job-<task-id>.json` görev bağlamını ve sonucu içerir; `sessions.json` ajan–Codex oturum eşlemesini tutar. Görev kimlikleri Gossipcat'in sekiz karakterli kimlikleriyle uyumludur. Kayıt sınırı 5000 görevdir; sistem sınırda açık hata verir. CLI görev zaman aşımı 5 dakikadır. Yazma ve görsel görevleri desteklenmez.

## Doğrulama

İki gerçek görev aynı GPT-6.1 Sol oturumunda çalıştırıldı. İkinci görev, ilkinde verilen benzersiz işareti ve dosya referansını konuşma geçmişinden doğru hatırladı. Aynı kimliğin yeniden gönderimi kayıtlı sonucu döndürdü. Kuyruk testleri yeniden başlatmada sonuç korunmasını, yarım kalan işin tekrar edilmemesini, sıralı çalışmayı, iptali, kimlik çatışmasını ve dosya izinlerini kapsar.

## Durdurma ve kaldırma

```sh
cd /Users/goku/Desktop/gossip
python3 scripts/codex-bridge-service.py stop
python3 scripts/codex-bridge-service.py uninstall
```

`stop` servisi durdurur ve bridge işaretini korur; dispatch servis kapalı hatası verir. `uninstall` LaunchAgent'ı ve `enabled` işaretini kaldırır, görev kayıtlarını korur; doğrudan önceki CLI worker yolu tekrar kullanılabilir. Kaynak kodu geri alma yedeği bu sohbetin outputs dizinindedir.

## Bu kurulumun etkinleştirme durumu

Kod, MCP bundle ve LaunchAgent kurulmuştur; plist doğrulaması başarılıdır. Bu Codex sandbox'ından `launchctl bootstrap` çağrısı `Input/output error (5)` döndürdü ve servis yüklenmedi. Sistem kayıt sorgusu da `Cannot run while sandboxed` dedi. Normal macOS Terminal'inde `python3 scripts/codex-bridge-service.py start` çalıştırılması gerekiyor; ardından Claude Code `/mcp` bağlantısını yeniden başlatın. Servis henüz arka planda etkin değildir.

124 test (7 paket), build:all, build:mcp, backend tip kontrolü ve diff kontrolü başarılı. İki gerçek GPT-6.1 Sol görevi aynı oturumu sürdürdü; tekrar gönderim ve gerçek tamamlanmış sonucun daemon yeniden başlatma sonrası aynı kalması doğrulandı. Kaynak analizi testinde gerçek dosyanın satır numaralı içeriği görev bağlamına verildi; doğrudan dosya okumadaki macOS sandbox sınırı ayrıca doğrulanmalıdır.

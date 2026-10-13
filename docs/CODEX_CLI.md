# Yerel Codex CLI worker

Gossipcat 0.9.0 görev akışına ayrı bir `codex exec` oturumu ekler. Claude native ajanları ve mevcut oturumlar korunur. MCP araçlarını yalnızca Codex'e bağlamak yerine, `gossip_dispatch` → Codex worker → `gossip_collect` akışı kullanılır. CLI worker aynı süreçteki görev pipeline'ına bağlıdır; ayrıca WebSocket ajanı açmaz.

## Yapılandırma

Mevcut `.gossip/config.json` içindeki `agents` nesnesine ekleyin:

```json
"codex-sol": {
  "provider": "openai",
  "model": "gpt-6.1-sol",
  "codexCli": true,
  "native": false,
  "role": "researcher",
  "skills": ["research", "code_review"]
}
```

`codexCli:true` API provider oluşturulmasını ve API anahtarı sorgusunu atlar. `native:true`, farklı model, `base_url` ve `key_ref` reddedilir. Model hiçbir koşulda sessizce değiştirilmez. `provider:openai` kimlik kaydını ifade eder; Codex görevi HTTP API worker'ına gönderilmez. Mevcut Gossipcat özetleyicileri kendi eski yapılandırmalarıyla çalışmaya devam eder; onlar Codex görev modeli değildir.

## Kurulum ve yeniden başlatma

Global `gossipcat` bir gossipcat deposuna bağlıysa (`npm link`), kaynak değişikliklerinden sonra depo kökünde:

```sh
npm run build:all
npm run build:mcp
```

Claude Code içinde `/mcp` açın ve Gossipcat bağlantısını yeniden başlatın; reconnect eski MCP sürecini değiştirmiyorsa Claude Code'u kapatıp aynı proje dizininde yeniden başlatın. Çalışan görevler bittikten sonra yeniden başlatın. `gossip_status` ajanı gösterir; kullanılabilirliğin asıl kontrolü dispatch/collect sonucudur. Mevcut `.claude.json`, MCP ayarları ve Claude ajanları değiştirilmez.

Codex Desktop'ın kurulu CLI'si macOS'ta otomatik bulunur; diğer sistemlerde `codex` PATH'ten alınır. Farklı bir binary için MCP sunucu ortamında `GOSSIP_CODEX_BIN=/tam/yol/codex` tanımlanabilir. CLI şu özellikleri desteklemelidir: `exec --json --output-schema --ignore-user-config --sandbox read-only`. Gerekirse normal terminalde `codex login` kullanın. API anahtarı gerekmiyor. Codex alt süreci yalnızca izinli ortam değişkenlerini alır: `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TERM`, `TMPDIR`, `LANG`, `LC_*`, `CODEX_HOME` (ChatGPT girişi buradan okunur, varsayılan `~/.codex`), proxy değişkenleri (`HTTP(S)_PROXY`, `NO_PROXY`, `ALL_PROXY`, küçük harfli biçimleri) ve TLS ayarları (`SSL_CERT_FILE`, `SSL_CERT_DIR`, `CODEX_CA_CERTIFICATE`). Claude ortamındaki API anahtarları, tokenlar ve diğer tüm değişkenler aktarılmaz (`codexChildEnv`, packages/orchestrator/src/codex-worker.ts).

## Kullanım: Claude Code / Gossipcat MCP

```text
gossip_dispatch(mode:"single", agent_id:"codex-sol",
  task:"packages/client/src/gossip-agent.ts dosyasındaki connect ve sendDirect fonksiyonlarını incele; gerçek dosya:satır referansları ver. Dosyaları değiştirme.")
gossip_collect(task_ids:["dispatch yanıtındaki görev kimliği"], timeout_ms:120000, consensus:false)
```

Codex görev kimliği ve ajan kimliğini prompt'ta, çalışma dizinini `-C` ile alır. Rol talimatları, dispatch bağlamı/skills ve projenin `AGENTS.md` talimatları aktarılır. Kullanıcı MCP sunucuları, hooks ve alternatif sağlayıcı ayarları otomasyon oturumuna yüklenmez. Varsayılan oturum kalıcıdır; `.gossip/codex-runs.jsonl` ajan/görev/oturum/model/çalışma dizini/çıkış kodu/durum eşlemesini saklar. Buradaki model başlatma parametresidir; gerçek model kanıtı Codex rollout kaydının `turn_context.model` alanıdır.

## Hata ve izin davranışı

- Salt okunur sandbox ve `approval_policy=never`; onay gerektiren işlemler hata döndürür.
- `write_mode` ve görüntü görevleri açık hata ile reddedilir. Yazma entegrasyonu henüz uygulanmadı.
- CLI sert zaman aşımı 5 dakikadır. Daha kısa `gossip_collect(timeout_ms)` çalışan görevi başarısız sayar ve süreci sonlandırır.
- Gossipcat iptali / worker kapanışı süreç grubuna SIGTERM, ardından gerekirse SIGKILL gönderir. Geç gelen sonuç iptal edilmiş görevi yeniden tamamlandı yapamaz.
- Süreç başlatma hatası, sıfır olmayan çıkış, bozuk/eksik JSON olayları, modelin `status:failed` sonucu ve eksik son yanıt başarısız görev olur.
- Kaynak erişimi olmayan bir açıklama başarılı iş sayılmaz; model yapılandırılmış `status:failed` döndürmelidir.

## Doğrulama ve sınır

115 hedefli test: worker başarı/hata/iptal/zaman aşımı, API anahtarlarının aktarılmaması, kesin model doğrulaması, yazma reddi ve mevcut config/dispatch/key-ref/utility regresyonları. `build:all` ve `build:mcp` başarılıdır.

MCP üzerinden gerçek kaynak snapshot'ı verildi, Codex analiz etti ve Gossipcat sonucu topladı. Dönen atıflar gerçek kaynak satırlarına karşı kontrol edildi. Codex CLI 0.162.0-alpha.17.2, Desktop 26.1007.30912, Git commit 57a9adfe ve `gpt-6.1-sol` çalışma kaydı doğrulandı.

Bu Codex ajanının içinde başlatılan alt CLI, macOS'ta iç içe sandbox nedeniyle doğrudan dosya okuma komutlarında `sandbox_apply: Operation not permitted` aldı. Bu nedenle tamamlanan doğrulamada modülün gerçek, satır numaralı içeriği görev bağlamına kondu; doğrudan dosya erişimi başarıyla doğrulanmadı. Normal Claude Code terminalinden doğrudan dosya erişimi ayrıca denenmelidir. Sandbox'ı kapatan bir geçiş eklenmedi.



Kalıcı kuyruk ve aynı oturumu sürdüren takip görevleri için [CODEX_BRIDGE.md](CODEX_BRIDGE.md) belgesine bakın.

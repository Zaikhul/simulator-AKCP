# outlet-monitoring-demo — JavaScript MQTT backend & AKCP simulator

Monorepo Node.js yang berisi backend ingest MQTT dan dummy producer `akcpsim` untuk sensor `TEMPERATURE`, `TEMPERATURE_HUMIDITY`, `DOOR`, `MOTION`, `POWER`, dan `PANIC_BUTTON`.

**Pilihan bahasa:** backend dan simulator diimplementasikan dalam **JavaScript**, mengikuti permintaan awal. Deskripsi tugas yang menyebut Go digunakan sebagai acuan fungsional. Paket ini merupakan implementasi mandiri, karena monorepo asal serta `apps/api/internal/akcp/message.go` dan `ingest.go` tidak disertakan. Kompatibilitas persis dengan parser Go tersebut belum dapat diverifikasi; lihat [kontrak MQTT](docs/PROTOCOL.md).

## Jalankan semua layanan dengan Docker

Prasyarat: Docker Engine/Docker Desktop dengan Compose v2.

```bash
docker compose up -d --build
docker compose logs -f api akcpsim
```

Periksa hasil dari terminal lain:

```bash
curl http://127.0.0.1:3000/ready
curl http://127.0.0.1:3000/api/v1/sensors
curl http://127.0.0.1:3000/api/v1/events
curl http://127.0.0.1:3000/api/v1/alarms
```

Port broker `1883` dan API `3000` dipublikasikan pada `127.0.0.1`. MQTT dalam jaringan Compose menuju `mosquitto:1883`. Volume `api-data` menyimpan SQLite, sedangkan `mqtt-data` menyimpan data broker. `docker compose down` menghentikan layanan dan mempertahankan volume.

Profil awal `realistic` membuat power outage dan panic button lebih jarang daripada pintu dan gerakan. Untuk melihat semua jenis event dengan cepat, ganti simulator yang berjalan dengan timeline 20 detik:

```bash
docker compose stop akcpsim
docker compose run --rm --no-deps akcpsim node apps/akcpsim/src/index.js --scenario config/scenario-demo.json --duration 20
```

Timeline mengirim tepat delapan `status_change`: alarm dan pemulihan untuk setiap sensor diskrit. Riwayat API dapat berisi event tambahan dari simulator yang berjalan sebelumnya. Setelah timeline selesai, keadaan semua sensor diskrit normal. Mulai kembali simulator kontinu dengan `docker compose start akcpsim`.

## Jalankan JavaScript secara lokal

Prasyarat: **Node.js 24+**, npm, dan Mosquitto lokal atau broker MQTT lain yang mendukung MQTT 3.1.1/QoS 1. Jalankan perintah dari direktori root hasil ekstraksi ZIP.

```bash
npm ci
```

File `.env` opsional. Salin `.env.example` menjadi `.env`, lalu ubah nilainya. Pada Windows PowerShell, gunakan `Copy-Item .env.example .env`; pada Linux/macOS, gunakan `cp .env.example .env`.

Jika broker belum tersedia, jalankan layanan broker dari paket ini:

```bash
docker compose up -d mosquitto
```

Terminal pertama:

```bash
npm run api
```

Terminal kedua:

```bash
npm run sim -- --scenario config/scenario-demo.json --duration 20
```

Untuk simulator kontinu yang realistis:

```bash
npm run sim -- --profile realistic --interval 5 --seed 42
```

Untuk menjalankan API dan simulator profil `demo` dari satu terminal, setelah broker tersedia:

```bash
npm run demo
```

`Ctrl+C` menghentikan proses dan menutup koneksi MQTT. `npm run demo` menunggu API siap sebelum memulai simulator.

## Contoh konfigurasi

Broker berbeda, MAC berbeda, interval dua detik:

```bash
npm run sim -- --host 192.168.1.10 --port 1883 --mac 00:0B:DC:DE:40:01 --interval 2 --profile demo
npm run api -- --host 192.168.1.10 --port 1883
```

Override MAC wajib diterapkan juga pada konfigurasi perangkat API agar pesan dikenali. Contoh MAC di atas sama dengan MAC bawaan setelah normalisasi. Untuk MAC lain, ubah `config/devices.json` atau gunakan berkas konfigurasi terpisah pada kedua aplikasi.

Tanpa broker, periksa topic, payload, QoS, dan retain sebagai JSON Lines:

```bash
npm run sim -- --dry-run --scenario config/scenario-demo.json --duration 20
```

Percepat waktu simulasi lima kali untuk pengujian:

```bash
npm run sim -- --scenario config/scenario-demo.json --speed 5 --duration 4
```

`--duration` memakai detik waktu nyata; `--speed` mempercepat timeline dan interval simulasi. Log dikirim ke stderr, sedangkan dry-run memakai stdout. Payload `timestamp` tetap memakai Unix seconds waktu pengiriman. Gunakan kecepatan normal untuk uji timestamp/duplikasi yang mendekati perangkat nyata.

Bantuan lengkap:

```bash
npm run sim -- --help
npm run api -- --help
```

## Perilaku sensor

| Sensor | Metrik | Rutin/normal | Alarm | Pemulihan |
|---|---|---:|---:|---:|
| TEMPERATURE | Suhu °C | 2 | — | — |
| TEMPERATURE_HUMIDITY | Suhu °C dan kelembapan %RH, topik terpisah | 2 | — | — |
| DOOR | Pintu tertutup/terbuka | 9 | 8 | 9 |
| MOTION | Area bersih/gerakan | 9 | 8 | 9 |
| POWER | Daya tersedia/terputus | 11 | 10 | 11 |
| PANIC_BUTTON | Tombol dilepas/ditekan | 9 | 8 | 9 |

Analog memakai perubahan bertahap, noise kecil, variasi periodik, dan batas nilai. Temperatur probe gabungan memengaruhi kelembapan relatif secara ringan. Saat power outage, target temperatur naik sedikit. Analog yang diproduksi tetap berstatus normal `2`, sesuai lingkup tugas.

Diskrit memakai state machine dengan durasi aktif dan idle tersendiri. `status_change` diterbitkan hanya saat state berubah, kemudian sensor kembali normal. Snapshot awal dan heartbeat `status` juga memuat keadaan diskrit terkini. `TEMPERATURE_HUMIDITY` menerbitkan dua pesan dengan compound ID berbeda, sehingga satu snapshot menghasilkan **tujuh metrik** dari enam sensor.

## Kontrak MQTT

```text
spp/<MAC_TANPA_PEMISAH>/sensor/<status|status_change>/<compound_id>
```

Contoh suhu dalam engineering units:

```json
{"timestamp":1700000000,"value":25.3,"status":2}
```

Contoh power outage:

```text
topic: spp/000BDCDE4001/sensor/status_change/0.1.0.3.0
payload: {"timestamp":1700000001,"value":0,"status":10}
```

Semua publish dan subscription memakai QoS 1. Simulator menunggu PUBACK sebelum mengirim pesan selanjutnya dan memakai `retain: false`. Client ID otomatis berbentuk `akcp-sim-<MAC>-<random_suffix>` untuk mencegah dua proses saling memutus koneksi.

Mapping compound ID berada di `config/devices.json`. **ID bawaan adalah mapping demo**, bukan jaminan OID/port SP1+ pada perangkat Anda. Gunakan compound ID dari perangkat atau mapping monorepo asal untuk integrasi.

Jika parser asal memakai nilai integer berskala, pilih `AKCP_VALUE_FORMAT=raw` atau `--value-format raw` pada **kedua aplikasi**. Faktor `scale` tiap metrik dapat dikonfigurasi; demo memakai suhu ×10 dan kelembapan ×100. API menyajikan nilai hasil decoding dalam °C/%RH dan mempertahankan `rawValue`. Faktor ini adalah konfigurasi paket, sehingga tetap harus dicocokkan dengan firmware/parser Anda. Basis timestamp paket adalah detik, bukan milidetik.

## HTTP API

| Metode | Endpoint | Kegunaan |
|---|---|---|
| GET | `/health` | Liveness, koneksi broker, dan penghitung ingest |
| GET | `/ready` | 200 jika broker tersambung dan subscribe berhasil; 503 jika belum siap |
| GET | `/api/v1/devices` | Perangkat yang dikonfigurasi |
| GET | `/api/v1/sensors` | Seluruh metrik dan pembacaan terakhir |
| GET | `/api/v1/alarms` | Metrik yang saat ini aktif/alarm |
| GET | `/api/v1/telemetry` | Riwayat seluruh pembacaan |
| GET | `/api/v1/events` | Riwayat alarm dan pemulihan |

Riwayat mendukung `mac`, `sensorId`, `limit` (1–500, default 100), dan `before` (cursor ID). Riwayat diurutkan dari terbaru. Gunakan `nextBefore` dari respons untuk halaman selanjutnya.

```bash
curl "http://127.0.0.1:3000/api/v1/events?sensorId=power&limit=20"
curl "http://127.0.0.1:3000/api/v1/telemetry?mac=000BDCDE4001&limit=100"
```

Tetapkan `API_TOKEN` jika endpoint data perlu bearer token. `/health` dan `/ready` tetap dapat diperiksa tanpa token.

```bash
curl -H "Authorization: Bearer TOKEN_ANDA" http://127.0.0.1:3000/api/v1/sensors
```

Spesifikasi API tersedia di [docs/openapi.yaml](docs/openapi.yaml).

## Konfigurasi dan penyimpanan

Prioritas: flag CLI → environment → default. `.env` di root dibaca secara otomatis dan tidak menimpa environment yang telah ditetapkan. `MQTT_URL` mengambil prioritas atas `MQTT_HOST`/`MQTT_PORT` dari environment; flag `--host`/`--port` dapat menimpanya. Jangan menggabungkan flag `--broker-url` dengan `--host`/`--port`.

SQLite memakai WAL dan transaksi untuk telemetri, pembacaan terakhir, serta event. Pesan identik dengan MAC, event, compound ID, timestamp, value, dan status sama dideduplikasi. Heartbeat aktif tidak menambah alarm berulang. Pesan dengan timestamp lebih lama tetap masuk riwayat tetapi tidak menimpa keadaan terbaru.

`API_MAX_TELEMETRY_ROWS` membatasi riwayat telemetry dan events masing-masing (default 100.000). Pembacaan terakhir tetap disimpan. Deduplication bertahan setelah restart selama sampel terkait masih berada dalam jendela riwayat. Snapshot pertama yang sudah aktif diberi label `INITIAL_ALARM`, sehingga dapat dibedakan dari transisi yang benar-benar diamati.

Gunakan file database terpisah jika mengganti `engineering` menjadi `raw`; startup menolak format yang tidak sama dengan metadata database yang sudah ada.

Untuk username/password broker, gunakan `MQTT_USERNAME` dan `MQTT_PASSWORD`. Untuk TLS, gunakan `MQTT_URL=mqtts://...`, `MQTT_CA_FILE`, serta pasangan `MQTT_CERT_FILE`/`MQTT_KEY_FILE` jika diperlukan. Verifikasi sertifikat tetap aktif. Broker Compose memakai anonymous access untuk demo lokal; konfigurasi autentikasi broker eksternal mengikuti kebijakan broker tersebut.

## Pengujian

```bash
npm run check
npm test
```

Test integrasi menjalankan broker Aedes di TCP loopback dan memeriksa payload QoS 1, API, reconnect, deduplikasi, dan delapan transisi. Untuk menjalankan pengujian yang sama terhadap **Eclipse Mosquitto** yang terpasang di PATH:

```bash
npm run smoke:mosquitto
```

Jika executable berbeda, tetapkan `MOSQUITTO_BIN` ke path executable. Script ini memulai broker sementara pada port bebas, menjalankan API/simulator, lalu menghentikannya. Hasil pengujian paket tersedia di [docs/VERIFICATION.md](docs/VERIFICATION.md).

## Struktur

| Direktori | Isi |
|---|---|
| `apps/api/src` | Ingest, SQLite, dan HTTP API |
| `apps/akcpsim/src` | CLI, runner, dan engine simulasi |
| `packages/akcp/src` | Topic/payload, status, registry, konfigurasi, koneksi MQTT |
| `config` | Mapping perangkat dan timeline skenario |
| `infra/mosquitto` | Konfigurasi Eclipse Mosquitto |
| `tests` | Unit dan integrasi melalui TCP MQTT |
| `scripts` | Demo, validasi syntax, dan smoke test Mosquitto |
| `docs` | Kontrak MQTT, OpenAPI, dan hasil verifikasi |

## Batas lingkup

Paket ini adalah backend demo dan simulator. Tidak ada UI atau integrasi database monorepo asal. Koneksi memakai clean session, dan simulator tidak memiliki durable outbox lintas restart. QoS 1 berlaku pada transport selama sesi berjalan; PUBACK broker bukan konfirmasi transaksi SQLite backend. Reconnect otomatis menangani gangguan singkat. Jika koneksi atau ACK melewati deadline, producer berhenti dengan exit code 1 agar kegagalan terlihat. Backend melaporkan ketidaksiapan melalui `/ready` selama terputus.

Referensi teknis: [manual MQTT AKCP](https://www.akcp.in.th/downloads/Manuals/MQTT/SP%2B%20and%20WTG%20MQTT%20Manual.pdf), [MQTT.js](https://github.com/mqttjs/MQTT.js), [MQTT 3.1.1 OASIS](https://docs.oasis-open.org/mqtt/mqtt/v3.1.1/mqtt-v3.1.1.html), dan [konfigurasi Mosquitto](https://mosquitto.org/man/mosquitto-conf-5.html).

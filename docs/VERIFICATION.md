# Hasil verifikasi

Tanggal: 12 Oktober 2026.

| Pemeriksaan | Hasil | Bukti |
|---|---|---|
| Syntax JavaScript dan JSON | PASS | `npm run check`: 28 file diperiksa |
| Unit dan integrasi MQTT TCP | PASS | `npm test`: 22 tests, 22 pass, 0 fail, 0 skip |
| Eclipse Mosquitto | PASS | Smoke test terhadap executable Mosquitto 2.0.18 |
| Snapshot enam sensor logis | PASS | Tujuh metrik: 3 analog dan 4 diskrit |
| Transisi diskrit | PASS | DOOR 8→9, MOTION 8→9, POWER 10→11, PANIC_BUTTON 8→9 |
| Pemulihan alarm | PASS | Delapan event dan nol alarm aktif setelah skenario selesai |
| Produksi telemetri | PASS | Smoke test menerima 70 sampel pada skenario dipercepat |
| QoS 1 | PASS | Publisher/subscriber meminta QoS 1; paket MQTT diperiksa pada integrasi TCP |
| Reconnect dan subscribe ulang | PASS | Koneksi subscriber diputus, tersambung ulang, dan ingest kembali berhasil |
| Duplikasi dan sampel lama | PASS | Pesan identik dideduplikasi; recovery lama tidak menghapus alarm terbaru |
| Persistence | PASS | SQLite dibuka kembali dan mempertahankan keadaan alarm serta fingerprint |
| Nilai analog | PASS | Simulasi satu jam menjaga batas nilai dan perubahan tiap sampel |
| Engineering/raw | PASS | Suhu dan RH ter-encode/decode sesuai faktor registry |
| Autentikasi HTTP dan input tidak valid | PASS | 401, 400, serta 405 sesuai kasus |
| Compose dan OpenAPI | PASS parsing | YAML dapat diparsing; ada 3 layanan dan 7 endpoint |
| Dependensi produksi | PASS saat diperiksa | `npm audit --omit=dev` melaporkan 0 vulnerability pada pemeriksaan ini |

Lingkungan verifikasi: Node.js v24.19.0, npm 11.9.0, Linux x86_64. Test integrasi otomatis memakai Aedes di TCP loopback. Pengujian Eclipse Mosquitto memakai broker sementara yang benar-benar dijalankan sebagai proses terpisah, bukan mock.

Output smoke test Mosquitto:

```json
{
  "result": "PASS",
  "broker": "Eclipse Mosquitto",
  "metrics": 7,
  "transitions": 8,
  "alarmsAfterRecovery": 0,
  "telemetry": 70,
  "qos": 1
}
```

Reproduksi:

```bash
npm ci
npm run check
npm test
npm run smoke:mosquitto
```

Untuk smoke test terakhir, executable `mosquitto` harus tersedia di PATH atau melalui `MOSQUITTO_BIN`.

Docker Engine tidak tersedia pada lingkungan verifikasi, sehingga `docker compose up --build` belum dieksekusi. Yang telah diperiksa adalah syntax konfigurasi Compose, konfigurasi aplikasi, dan alur MQTT/API secara langsung. Parser Go monorepo asal tidak tersedia, sehingga interoperabilitas persis dengan `message.go`/`ingest.go` belum diuji. Langkah pencocokan format terdapat di `PROTOCOL.md`.

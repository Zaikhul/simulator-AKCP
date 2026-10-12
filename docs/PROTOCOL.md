# Kontrak MQTT dan integrasi parser asal

## Dasar implementasi

Pola topic dan pemetaan status mengikuti spesifikasi pengguna. Referensi status `2`, `8`, `9`, `10`, dan `11` diperiksa pada manual AKCP SP+ and WTG MQTT. Karena file `message.go`/`ingest.go` tidak tersedia, schema payload minimal berikut merupakan kontrak implementasi paket ini, bukan hasil audit atas kode Go asal.

| Field JSON | Jenis | Arti |
|---|---|---|
| `timestamp` | integer positif | Unix seconds UTC saat pengiriman |
| `value` | number finite | Nilai engineering atau nilai scaled sesuai konfigurasi |
| `status` | integer | Kode status AKCP |

Simulator mengirim hanya tiga field ini. API menerima field tambahan tetapi tidak memakainya. MAC dan identitas metrik berasal dari topic; tipe sensor, nama, unit, dan scale berasal dari registry. Unit tidak ditebak berdasarkan angka value. `TEMPERATURE_HUMIDITY` berisi dua entri registry dengan sensor ID yang sama dan compound ID yang berbeda.

## Mapping bawaan

| Sensor ID | Tipe | Metrik | Compound ID demo | Unit |
|---|---|---|---|---|
| rack-temperature | TEMPERATURE | temperature | 0.0.0.0.0 | °C |
| room-th | TEMPERATURE_HUMIDITY | temperature | 0.0.0.1.0 | °C |
| room-th | TEMPERATURE_HUMIDITY | humidity | 0.2.0.1.0 | %RH |
| door | DOOR | switch | 0.1.0.1.0 | — |
| motion | MOTION | switch | 0.1.0.2.0 | — |
| power | POWER | switch | 0.1.0.3.0 | — |
| panic | PANIC_BUTTON | switch | 0.1.0.4.0 | — |

Compound ID bukan otomatis full SNMP OID. Ganti dengan ID yang diterbitkan perangkat/parser asal. Kombinasi `(mac, compoundId)` wajib unik; compound ID boleh sama pada MAC berbeda. MAC disimpan sebagai 12 karakter hexadecimal uppercase, tanpa pemisah.

## Jenis event

- `status`: snapshot awal dan pembacaan rutin setiap interval; diskrit memuat state saat itu.
- `status_change`: sekali untuk setiap perpindahan state diskrit.
- `value_change`: didukung oleh parser backend untuk integrasi; simulator paket ini memakai `status` sesuai tugas.

Publisher memakai `qos: 1`, `retain: false`. Subscription API memakai filter `spp/+/sensor/+/+` dengan QoS 1. MQTT.js memakai MQTT 3.1.1, reconnect otomatis, keepalive, serta deadline koneksi dan ACK.

## Semantik diskrit

| Tipe | Status aktif | Status normal | Value aktif/normal | State API aktif/normal |
|---|---:|---:|---|---|
| DOOR | 8 | 9 | 0 / 1 | OPEN / CLOSED |
| MOTION | 8 | 9 | 0 / 1 | DETECTED / CLEAR |
| POWER | 10 | 11 | 0 / 1 | OFF / ON |
| PANIC_BUTTON | 8 | 9 | 0 / 1 | PRESSED / RELEASED |

Mapping aktif/normal adalah mapping aplikasi yang diminta pengguna. Nilai `0/1` pada POWER adalah dummy keadaan, bukan pembacaan tegangan dalam volt. Parser API menentukan alarm dari status yang benar untuk keluarga sensor. Status switch 8/9 ditolak untuk sensor POWER, dan 10/11 ditolak untuk DOOR/MOTION/PANIC_BUTTON.

Analog simulator selalu memakai normal `2`. Backend juga mengenali status analog AKCP `1,3,4,5,6,7,13,14,15` sebagai kondisi nonnormal yang membutuhkan perhatian; kategorisasi warning/error lebih rinci dapat ditambahkan dalam backend asal jika diperlukan.

## Engineering dan raw

| Mode | Suhu 25,3 °C pada wire | RH 55,40% pada wire |
|---|---:|---:|
| engineering (default) | 25.3 | 55.4 |
| raw, scale demo 10/100 | 253 | 5540 |

Mode, satuan, dan scale wajib diselaraskan pada producer dan consumer. Contoh scale di atas adalah konfigurasi demo, sehingga perlu dibandingkan dengan pesan perangkat nyata dan pembagian nilai pada parser Go. Field `rawValue` pada API menyimpan angka wire; `value` pada API adalah hasil decoding engineering.

## Riwayat dan QoS 1

QoS 1 memungkinkan redelivery. Backend membuat fingerprint dari tuple canonical `(MAC, event, compoundId, timestamp, value, status)`, sehingga JSON dengan urutan field berbeda tetap dideduplikasi. MQTT packet ID tidak dipakai sebagai identitas permanen.

Event alarm dibuat ketika pembacaan terkini pindah dari normal menjadi aktif; pemulihan dibuat ketika beralih ke normal. Pembacaan rutin dengan status sama tidak membuat event berulang. State awal aktif diberi `INITIAL_ALARM`. Sampel yang lebih lama dari pembacaan terakhir tetap diarsipkan tanpa mengubah state terbaru.

Untuk timestamp sama, urutan penerimaan digunakan. Proses simulator mengirim pesan secara serial dan menunggu PUBACK. Dua producer dengan MAC dan metrik sama bisa menciptakan state yang saling menimpa; gunakan MAC berbeda untuk perangkat simulasi berbeda. Payload minimal memiliki resolusi waktu satu detik, sehingga dua sampel identik pada topic yang sama dalam detik yang sama diperlakukan sebagai satu sampel. Untuk kebutuhan frekuensi tinggi, tambahkan ID pesan unik dan sesuaikan parser asal sebelum memperluas kontrak.

Riwayat dan fingerprint dibatasi oleh `API_MAX_TELEMETRY_ROWS`. Setelah sebuah sampel keluar dari retensi, deduplikasi terhadap sampel itu tidak lagi dijamin. Pembacaan terbaru tetap tersedia, dan state lebih lama tidak menimpa state terbaru.

## Menghubungkan dengan monorepo Go asal

1. Bandingkan nama field, tipe `timestamp`, dan representasi `value` dengan `apps/api/internal/akcp/message.go`.
2. Cocokkan mapping MAC/compound ID, pengelompokan sensor, scale, dan status dengan `ingest.go` serta data konfigurasi/database monorepo asal.
3. Ubah `config/devices.json` dan mode `--value-format` agar sama dengan consumer.
4. Jika nama field/wrapper berbeda, ubah pembuatan `payload` di `apps/akcpsim/src/engine.js` dan parsing `packages/akcp/src/protocol.js`. Gunakan contoh pesan asli sebagai fixture pengujian.
5. Jalankan hanya satu producer untuk MAC/metrik yang sama. Jika menggunakan backend Go asal, jalankan `npm run sim` menuju broker yang sama; backend JavaScript di paket ini dapat dijalankan sebagai consumer pembanding.

Tidak ada klaim bahwa konfigurasi contoh mewakili jumlah port fisik SP1+ tertentu. Konfigurasi mengelompokkan enam jenis sensor logis untuk menunjukkan seluruh kebutuhan tugas.

## Memperluas perangkat dan skenario

Tambahkan objek perangkat baru pada array `devices`; gunakan MAC berbeda. Tambahkan sensor sesuai type yang didukung. `TEMPERATURE` membutuhkan satu metric temperature, `TEMPERATURE_HUMIDITY` membutuhkan temperature dan humidity, sedangkan diskrit membutuhkan satu compound ID dan rentang `timing`.

Skenario memakai daftar `{atSeconds, sensorId, state}`. Pada konfigurasi multi-device, setiap event juga wajib menyertakan `mac`. Untuk konfigurasi satu perangkat, MAC dapat dihilangkan agar mengikuti override MAC CLI. `state` hanya `active` atau `normal`. Rentang waktu memakai detik simulasi. Ketika skenario diaktifkan, event diskrit acak dinonaktifkan; analog dan heartbeat terus berjalan. Skenario tidak mengulang otomatis.

Sumber: [AKCP SP+ and WTG MQTT Manual](https://www.akcp.in.th/downloads/Manuals/MQTT/SP%2B%20and%20WTG%20MQTT%20Manual.pdf), [MQTT.js API](https://github.com/mqttjs/MQTT.js), [MQTT 3.1.1](https://docs.oasis-open.org/mqtt/mqtt/v3.1.1/mqtt-v3.1.1.html).

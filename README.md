# Tablespot Dashboard

Dashboard web untuk monitoring ketersediaan kursi dan meja kafe secara real-time, menggunakan Firebase Realtime Database.

---

## Prasyarat

- Proyek Firebase yang sudah aktif dengan:
  - **Realtime Database** diaktifkan
  - **Authentication** diaktifkan (Email/Password provider)
  - Minimal satu akun pengguna untuk login sebagai staf
- Browser modern (Chrome, Firefox, Edge, Safari terkini)
- Python 3 (untuk menjalankan lokal) **atau** Firebase CLI (untuk deploy)

---

## Langkah 1 — Isi Konfigurasi Firebase

1. Buka [Firebase Console](https://console.firebase.google.com) → pilih proyek Anda.
2. Klik ikon roda gigi ⚙ → **Setelan proyek** → tab **Umum**.
3. Gulir ke bawah ke bagian **Aplikasi web Anda** → salin nilai konfigurasi.
4. Buka file `public/firebase-config.js` dan ganti nilai placeholder:

```js
export const firebaseConfig = {
  apiKey:      "GANTI_DENGAN_API_KEY_ANDA",
  authDomain:  "nama-proyek.firebaseapp.com",
  databaseURL: "https://nama-proyek-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId:   "nama-proyek",
  appId:       "1:123456789:web:abc123",
};
```

> ⚠ **Jangan commit** `firebase-config.js` ke repositori publik.
> File ini sudah tercantum di `.gitignore` sebaiknya. Gunakan `firebase-config.example.js` sebagai referensi format.

---

## Langkah 2 — Aturan Keamanan Firebase Realtime Database

Pastikan aturan Realtime Database mengizinkan **baca publik** untuk path yang dibutuhkan dashboard dan **menolak semua penulisan**. Contoh minimal:

```json
{
  "rules": {
    "tables":  { ".read": true,  ".write": false },
    "seats":   { ".read": true,  ".write": false },
    "system":  { ".read": true,  ".write": false },
    "stats": {
      ".read": "auth != null",
      ".write": false
    },
    "$other":  { ".read": false, ".write": false }
  }
}
```

> Catatan: path `stats/` dibatasi hanya untuk pengguna yang sudah login (staf).

---

## Langkah 3 — Menjalankan Lokal

Gunakan server HTTP lokal agar ES module (`type="module"`) dan `import` berfungsi dengan benar. **Jangan buka `index.html` langsung via `file://`** karena browser akan memblokir ES module dari filesystem.

### Cara termudah: Python

```bash
cd public
python -m http.server 8080
```

Buka browser dan akses: **http://localhost:8080**

### Alternatif: Node.js `npx serve`

```bash
npx serve public -p 8080
```

---

## Langkah 4 — Deploy ke Firebase Hosting

> Pastikan [Firebase CLI](https://firebase.google.com/docs/cli) sudah terinstal.

### 4a. Login ke Firebase (lakukan sekali)

```bash
firebase login
```

### 4b. Inisialisasi proyek (lakukan sekali jika belum ada `.firebaserc`)

```bash
firebase init hosting
```

Saat ditanya:
- **Project**: pilih proyek Firebase Anda
- **Public directory**: ketik `public`
- **Configure as single-page app**: `Yes`
- **Set up automatic builds**: `No`
- **Overwrite `public/index.html`**: `No` (jangan timpa!)

### 4c. Deploy

```bash
firebase deploy --only hosting
```

URL live akan tampil setelah proses selesai.

---

## Struktur File

```
TableSpot Dashboard/
├── firebase.json               ← Konfigurasi Firebase Hosting
├── README.md                   ← Dokumen ini
└── public/
    ├── index.html              ← Halaman tunggal (SPA)
    ├── style.css               ← Semua gaya antarmuka
    ├── app.js                  ← Logika utama (ES module)
    ├── firebase-config.js      ← Konfigurasi Firebase (ISI SENDIRI, jangan di-commit)
    └── firebase-config.example.js  ← Contoh format konfigurasi
```

---

## Fitur Utama

| Tab | Akses | Fitur |
|-----|-------|-------|
| Denah | Publik (tanpa login) | Kartu meja real-time, status kursi, ringkasan kosong/terisi, banner offline |
| Statistik | Staf (login email+password) | Grafik okupansi per jam, kartu ringkasan, tabel pemakaian per meja |

---

## Troubleshooting

| Masalah | Kemungkinan Penyebab | Solusi |
|---------|---------------------|--------|
| Halaman putih / error di konsol | `firebase-config.js` belum diisi | Isi dengan konfigurasi Firebase Anda |
| "Akses ditolak" | Aturan keamanan database terlalu ketat | Periksa rules di Firebase Console |
| Grafik tidak muncul | Data `stats/jam` belum ada | Bridge perlu berjalan minimal beberapa jam untuk mengumpulkan data |
| "Sistem tidak terhubung" | Bridge Python mati / `system/beat` berhenti berubah | Pastikan bridge berjalan di sisi server |
| Login gagal | Email/password salah atau akun belum dibuat | Buat akun di Firebase Console → Authentication → Users |

---

*Proyek Akhir Semester — Informatika*

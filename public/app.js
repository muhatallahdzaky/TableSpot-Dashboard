/**
 * app.js — Tablespot Dashboard
 *
 * Arsitektur:
 *   - firebase-config.js : konfigurasi Firebase (diisi pengguna)
 *   - Data layer         : fungsi-fungsi yang membaca Firebase & menyimpan state
 *   - Render layer       : fungsi-fungsi yang menulis ke DOM berdasar state
 *   - Controller         : menghubungkan data layer ke render layer
 *
 * Firebase SDK dimuat via CDN (ES module shim), sehingga file ini
 * menggunakan import statis di atas. Tidak ada npm, tidak ada build step.
 *
 * HANYA MEMBACA dari Firebase. Tidak ada penulisan ke database.
 */

// ============================================================
// Import Firebase SDK (modular, CDN gstatic versi dipin)
// ============================================================
import { initializeApp }                        from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getDatabase, ref, onValue }            from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import {
  getAuth,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
}                                               from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { firebaseConfig }                       from "./firebase-config.js";

// ============================================================
// Konfigurasi kafe (sesuai spesifikasi)
// ============================================================

/** Daftar meja dengan kursi-kursi miliknya */
const MEJA_CONFIG = [
  { id: "M1", kursi: ["K1", "K2"] },
  { id: "M2", kursi: ["K3", "K4"] },
  { id: "M3", kursi: ["K5"] },
  { id: "M4", kursi: ["K6"] },
  { id: "M5", kursi: ["K7"] },
];

/** Jam operasional yang dilacak statistiknya */
const JAM_RANGE = Array.from({ length: 15 }, (_, i) => String(i + 8).padStart(2, "0")); // "08".."22"

// ============================================================
// State global (diisi oleh data layer, dibaca oleh render layer)
// ============================================================

const state = {
  // Denah
  tables: {},          // { M1: {status, since}, ... }
  seats:  {},          // { K1: {table, status, since}, ... }
  beatLastChanged: null, // Date.now() saat beat terakhir berubah
  beatValue: null,       // nilai beat terakhir
  beatOfflineTimer: null,// id setInterval pengecekan offline

  // Statistik
  statsJamKerja:      {},  // { "08": 0.5, ... }
  statsJamAkhirPekan: {},  // { "08": 0.3, ... }
  statsJamTersibuk:   {},  // { kerja: "14", akhir_pekan: "15" }
  statsHariIni:       {},  // { giliran, puncak_terisi, puncak_jam, rata_lama_menit }
  statsMeja:          {},  // { M1: {giliran, rata_lama_menit, persen_terisi}, ... }
  statsUpdated:       null,// milidetik

  // Auth
  currentUser: null,
};

// ============================================================
// Inisialisasi Firebase
// ============================================================

let app, db, auth;

try {
  app  = initializeApp(firebaseConfig);
  db   = getDatabase(app);
  auth = getAuth(app);
} catch (err) {
  renderFatalError(
    "Gagal menghubungkan ke Firebase",
    "Pastikan firebase-config.js sudah diisi dengan benar. Error: " + err.message
  );
  throw err; // hentikan eksekusi selanjutnya
}

// ============================================================
// Utilitas
// ============================================================

/**
 * Format waktu relatif dari timestamp (milidetik) ke string
 * seperti "baru saja", "5 menit lalu", "2 jam lalu", dst.
 * @param {number|null} since - epoch ms
 * @returns {string}
 */
function formatRelative(since) {
  if (!since) return "—";
  const diff = Math.floor((Date.now() - since) / 1000); // detik
  if (diff < 10)  return "baru saja";
  if (diff < 60)  return `${diff} detik lalu`;
  if (diff < 3600) {
    const m = Math.floor(diff / 60);
    return `${m} menit lalu`;
  }
  if (diff < 86400) {
    const h = Math.floor(diff / 3600);
    return `${h} jam lalu`;
  }
  const d = Math.floor(diff / 86400);
  return `${d} hari lalu`;
}

/**
 * Kembalikan label teks status dalam bahasa Indonesia.
 * @param {"available"|"occupied"|"offline"|string} status
 * @returns {string}
 */
function labelStatus(status) {
  switch (status) {
    case "available": return "Kosong";
    case "occupied":  return "Terisi";
    case "offline":   return "Offline";
    default:          return "—";
  }
}

/**
 * Kembalikan ikon (karakter unicode) untuk status.
 * @param {"available"|"occupied"|"offline"|string} status
 * @returns {string}
 */
function ikonStatus(status) {
  switch (status) {
    case "available": return "✓";
    case "occupied":  return "●";
    case "offline":   return "○";
    default:          return "?";
  }
}

/**
 * Kembalikan kelas CSS modifier untuk status.
 * @param {"available"|"occupied"|"offline"|string} status
 * @returns {string}
 */
function classStatus(status) {
  switch (status) {
    case "available": return "available";
    case "occupied":  return "occupied";
    default:          return "offline";
  }
}

/**
 * Format persentase 0-1 menjadi string "XX%".
 * @param {number|null|undefined} val
 * @returns {string}
 */
function fmtPct(val) {
  if (val == null || isNaN(val)) return "—";
  return Math.round(val * 100) + "%";
}

/**
 * Format menit menjadi string "X mnt" atau "X jam Y mnt".
 * @param {number|null|undefined} mnt
 * @returns {string}
 */
function fmtMenit(mnt) {
  if (mnt == null || isNaN(mnt)) return "—";
  const m = Math.round(mnt);
  if (m < 60) return `${m} mnt`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r > 0 ? `${h} jam ${r} mnt` : `${h} jam`;
}

/**
 * Escape karakter HTML agar aman dimasukkan ke innerHTML.
 * @param {string} str
 * @returns {string}
 */
function esc(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ============================================================
// Data Layer — membaca Firebase
// ============================================================

/**
 * Pasang semua listener realtime untuk data denah:
 *   tables/, seats/, system/beat
 * Setiap listener memanggil fungsi render setelah memperbarui state.
 */
function startDenahListeners() {
  // --- tables/ ---
  onValue(
    ref(db, "tables"),
    (snap) => {
      state.tables = snap.val() || {};
      renderDenah();
    },
    (err) => {
      renderDenahError(err);
    }
  );

  // --- seats/ ---
  onValue(
    ref(db, "seats"),
    (snap) => {
      state.seats = snap.val() || {};
      renderDenah();
    },
    (err) => {
      renderDenahError(err);
    }
  );

  // --- system/beat ---
  onValue(
    ref(db, "system/beat"),
    (snap) => {
      const val = snap.val();
      // Deteksi perubahan: catat waktu lokal saat nilai beat berubah
      if (val !== state.beatValue) {
        state.beatValue       = val;
        state.beatLastChanged = Date.now();
        renderBeatBanner(false); // beat baru → banner hilang
      }
    },
    (_err) => {
      // Gagal baca beat: anggap offline
      state.beatLastChanged = null;
      renderBeatBanner(true);
    }
  );

  // Cek beat setiap 5 detik; tampilkan banner jika >30 detik tidak berubah
  state.beatOfflineTimer = setInterval(() => {
    if (state.beatLastChanged === null) return;
    const usia = Date.now() - state.beatLastChanged;
    renderBeatBanner(usia > 30_000);
  }, 5_000);
}

/**
 * Pasang listener untuk semua data statistik (hanya saat sudah login).
 */
function startStatsListeners() {
  // stats/jam/kerja
  onValue(ref(db, "stats/jam/kerja"), (snap) => {
    state.statsJamKerja = snap.val() || {};
    renderStatsChart();
  });

  // stats/jam/akhir_pekan
  onValue(ref(db, "stats/jam/akhir_pekan"), (snap) => {
    state.statsJamAkhirPekan = snap.val() || {};
    renderStatsChart();
  });

  // stats/jam/tersibuk
  onValue(ref(db, "stats/jam/tersibuk"), (snap) => {
    state.statsJamTersibuk = snap.val() || {};
    renderStatsSummaryCards();
  });

  // stats/hari_ini
  onValue(ref(db, "stats/hari_ini"), (snap) => {
    state.statsHariIni = snap.val() || {};
    renderStatsSummaryCards();
  });

  // stats/meja (semua meja sekaligus)
  onValue(ref(db, "stats/meja"), (snap) => {
    state.statsMeja = snap.val() || {};
    renderStatsMejaTable();
  });

  // stats/updated
  onValue(ref(db, "stats/updated"), (snap) => {
    state.statsUpdated = snap.val();
    renderStatsUpdated();
  });
}

// ============================================================
// Hitung ringkasan dari state
// ============================================================

/**
 * Hitung jumlah kursi kosong (available) dan meja kosong (available).
 * Offline TIDAK dihitung kosong.
 * @returns {{ kursiKosong: number, mejaKosong: number }}
 */
function hitungRingkasan() {
  let kursiKosong = 0;
  let mejaKosong  = 0;

  // Kursi: iterasi seats/
  for (const id of ["K1","K2","K3","K4","K5","K6","K7"]) {
    const s = state.seats[id];
    if (s && s.status === "available") kursiKosong++;
  }

  // Meja: iterasi tables/
  for (const id of ["M1","M2","M3","M4","M5"]) {
    const t = state.tables[id];
    if (t && t.status === "available") mejaKosong++;
  }

  return { kursiKosong, mejaKosong };
}

// ============================================================
// Render Layer — Denah
// ============================================================

/** Referensi elemen DOM yang dipakai oleh render layer */
const el = {
  bannerWarn:      () => document.getElementById("banner-warn"),
  denahContainer:  () => document.getElementById("denah-container"),
  summaryBar:      () => document.getElementById("summary-bar"),
  lastUpdated:     () => document.getElementById("last-updated"),

  // Statistik
  statsPanel:      () => document.getElementById("panel-statistik"),
  loginWrapper:    () => document.getElementById("login-wrapper"),
  statsContent:    () => document.getElementById("stats-content"),
  loginError:      () => document.getElementById("login-error"),
  loginEmail:      () => document.getElementById("login-email"),
  loginPassword:   () => document.getElementById("login-password"),
  loginBtn:        () => document.getElementById("login-btn"),
  logoutBtn:       () => document.getElementById("logout-btn"),
  statsUserLabel:  () => document.getElementById("stats-user-label"),
  statsCards:      () => document.getElementById("stats-cards"),
  chartToggleKerja:     () => document.getElementById("chart-toggle-kerja"),
  chartToggleAkhirPekan:() => document.getElementById("chart-toggle-akhirpekan"),
  chartCanvas:     () => document.getElementById("occupancy-chart"),
  statsMejaTableBody: () => document.getElementById("stats-meja-tbody"),
  statsUpdatedLabel:  () => document.getElementById("stats-updated-label"),
  noDataChartMsg:  () => document.getElementById("no-data-chart"),
  noDataMejaMsg:   () => document.getElementById("no-data-meja"),
};

/**
 * Tampilkan/sembunyikan banner peringatan beat.
 * @param {boolean} tampil
 */
function renderBeatBanner(tampil) {
  const banner = el.bannerWarn();
  if (!banner) return;
  if (tampil) {
    banner.classList.remove("hidden");
  } else {
    banner.classList.add("hidden");
  }
}

/**
 * Render seluruh tab Denah dari state.tables dan state.seats.
 */
function renderDenah() {
  const container = el.denahContainer();
  if (!container) return;

  // Bersihkan pesan loading/error sebelumnya
  container.innerHTML = buildDenahHTML();

  // Perbarui ringkasan
  renderSummary();

  // Perbarui timestamp
  renderLastUpdated();
}

/**
 * Bangun HTML grid meja + kursi dari state.
 * @returns {string} HTML string
 */
function buildDenahHTML() {
  return `<div class="meja-grid">
    ${MEJA_CONFIG.map(meja => buildMejaCardHTML(meja)).join("")}
  </div>`;
}

/**
 * Bangun HTML satu kartu meja beserta kursi-kursinya.
 * @param {{ id: string, kursi: string[] }} meja
 * @returns {string}
 */
function buildMejaCardHTML({ id, kursi }) {
  const mejaData  = state.tables[id] || {};
  const status    = mejaData.status || "offline";
  const sinceMs   = mejaData.since  || null;
  const sinceText = formatRelative(sinceMs);

  const kursiHTML = kursi.map(kId => {
    const k   = state.seats[kId] || {};
    const ks  = k.status || "offline";
    return `<span class="kursi-chip kursi-chip--${classStatus(ks)}"
                  role="img"
                  aria-label="${esc(kId)}: ${esc(labelStatus(ks))}">
              <span class="icon" aria-hidden="true">${esc(ikonStatus(ks))}</span>
              ${esc(kId)}
            </span>`;
  }).join("");

  return `
    <article class="meja-card" aria-label="Meja ${esc(id)}">
      <div class="meja-card__header">
        <span class="meja-card__id">${esc(id)}</span>
        <span class="status-badge status-badge--${classStatus(status)}"
              role="status"
              aria-label="Status: ${esc(labelStatus(status))}">
          <span class="icon" aria-hidden="true">${esc(ikonStatus(status))}</span>
          ${esc(labelStatus(status))}
        </span>
      </div>
      <p class="meja-card__since">Sejak: ${esc(sinceText)}</p>
      <div class="kursi-list" aria-label="Kursi di meja ${esc(id)}">
        ${kursiHTML}
      </div>
    </article>`;
}

/**
 * Perbarui ringkasan kursi dan meja kosong.
 */
function renderSummary() {
  const bar = el.summaryBar();
  if (!bar) return;
  const { kursiKosong, mejaKosong } = hitungRingkasan();
  bar.innerHTML = `
    <span class="summary-chip">🪑 ${esc(String(kursiKosong))} dari 7 kursi kosong</span>
    <span class="summary-chip">🪵 ${esc(String(mejaKosong))} dari 5 meja kosong</span>
  `;
}

/**
 * Perbarui label "Terakhir diperbarui".
 */
function renderLastUpdated() {
  const lbl = el.lastUpdated();
  if (!lbl) return;
  const now = new Date().toLocaleTimeString("id-ID", {
    hour: "2-digit", minute: "2-digit", second: "2-digit"
  });
  lbl.textContent = `Terakhir diperbarui: ${now}`;
}

/**
 * Tampilkan pesan error di tab Denah.
 * @param {Error} err
 */
function renderDenahError(err) {
  const container = el.denahContainer();
  if (!container) return;
  const msg = err.code === "PERMISSION_DENIED"
    ? "Akses ke data ditolak. Periksa aturan keamanan Firebase."
    : `Gagal memuat data: ${err.message}`;
  container.innerHTML = `
    <div class="state-box" role="alert">
      <p class="state-box__title">⚠ Tidak Dapat Memuat Data</p>
      <p class="state-box__msg">${esc(msg)}</p>
    </div>`;
}

/**
 * Tampilkan pesan error fatal yang memblokir seluruh halaman.
 * @param {string} judul
 * @param {string} pesan
 */
function renderFatalError(judul, pesan) {
  const body = document.body;
  if (!body) return;
  body.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:system-ui,sans-serif;padding:2rem;">
      <div style="max-width:420px;text-align:center;">
        <p style="font-size:2rem;margin-bottom:1rem;">⚠️</p>
        <h1 style="font-size:1.2rem;margin-bottom:.5rem;">${esc(judul)}</h1>
        <p style="color:#6b7280;font-size:.9rem;">${esc(pesan)}</p>
      </div>
    </div>`;
}

// ============================================================
// Render Layer — Statistik
// ============================================================

/** Instance Chart.js aktif (agar bisa di-destroy sebelum dibuat ulang) */
let chartInstance = null;

/** Mode grafik saat ini: "kerja" atau "akhir_pekan" */
let chartMode = "kerja";

/**
 * Tampilkan form login, sembunyikan konten statistik.
 */
function renderLoginForm() {
  const lw = el.loginWrapper();
  const sc = el.statsContent();
  if (lw) lw.style.display = "";
  if (sc) sc.style.display = "none";
}

/**
 * Tampilkan konten statistik, sembunyikan form login.
 * @param {import("firebase/auth").User} user
 */
function renderStatsLoggedIn(user) {
  const lw  = el.loginWrapper();
  const sc  = el.statsContent();
  const lbl = el.statsUserLabel();
  if (lw)  lw.style.display  = "none";
  if (sc)  sc.style.display  = "";
  if (lbl) lbl.textContent   = user.email;

  // Mulai listener statistik (idempoten karena Firebase SDK sudah handle ini)
  startStatsListeners();
}

/**
 * Render kartu ringkasan statistik hari ini + jam tersibuk.
 */
function renderStatsSummaryCards() {
  const container = el.statsCards();
  if (!container) return;

  const hi = state.statsHariIni;
  const jt = state.statsJamTersibuk;

  const jamTersibukKerja     = jt.kerja       ? `Pukul ${jt.kerja}:00`      : "—";
  const jamTersibukAkhirPekan= jt.akhir_pekan ? `Pukul ${jt.akhir_pekan}:00` : "—";

  container.innerHTML = `
    <div class="stat-card">
      <p class="stat-card__label">Jam Tersibuk (Hari Kerja)</p>
      <p class="stat-card__value">${esc(jamTersibukKerja)}</p>
    </div>
    <div class="stat-card">
      <p class="stat-card__label">Jam Tersibuk (Akhir Pekan)</p>
      <p class="stat-card__value">${esc(jamTersibukAkhirPekan)}</p>
    </div>
    <div class="stat-card">
      <p class="stat-card__label">Giliran Hari Ini</p>
      <p class="stat-card__value">${esc(String(hi.giliran ?? "—"))}</p>
    </div>
    <div class="stat-card">
      <p class="stat-card__label">Rata-rata Lama Pemakaian</p>
      <p class="stat-card__value">${esc(fmtMenit(hi.rata_lama_menit))}</p>
      <p class="stat-card__sub">hari ini</p>
    </div>
  `;
}

/**
 * Render / refresh grafik batang Chart.js sesuai chartMode.
 */
function renderStatsChart() {
  const canvas    = el.chartCanvas();
  const noDataMsg = el.noDataChartMsg();
  if (!canvas) return;

  const dataset = chartMode === "kerja"
    ? state.statsJamKerja
    : state.statsJamAkhirPekan;

  // Cek apakah data tersedia
  const nilaiAda = JAM_RANGE.some(j => dataset[j] != null);
  if (!nilaiAda) {
    canvas.style.display     = "none";
    if (noDataMsg) noDataMsg.style.display = "";
    return;
  }

  canvas.style.display     = "";
  if (noDataMsg) noDataMsg.style.display = "none";

  const labels = JAM_RANGE.map(j => `${j}:00`);
  const values = JAM_RANGE.map(j => {
    const v = dataset[j];
    return v != null ? Math.round(v * 100) : 0;
  });

  // Warna batang: merah muda jika >80%, biru sebaliknya
  const bgColors = values.map(v =>
    v > 80 ? "rgba(220,38,38,0.75)" : "rgba(37,99,235,0.75)"
  );

  // Hancurkan chart lama sebelum membuat yang baru
  if (chartInstance) {
    chartInstance.destroy();
    chartInstance = null;
  }

  // Chart.js harus dimuat lewat window.Chart (dimuat via CDN di index.html)
  if (typeof Chart === "undefined") {
    console.warn("[Tablespot] Chart.js belum dimuat.");
    return;
  }

  chartInstance = new Chart(canvas, {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: "Okupansi (%)",
        data: values,
        backgroundColor: bgColors,
        borderRadius: 4,
        borderSkipped: false,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const v = ctx.parsed.y;
              return ` ${v}%${v > 80 ? " 🔴 ramai" : ""}`;
            },
          },
        },
      },
      scales: {
        y: {
          min: 0,
          max: 100,
          ticks: {
            callback: (v) => v + "%",
          },
          grid: { color: "rgba(0,0,0,.06)" },
        },
        x: {
          grid: { display: false },
          ticks: { font: { size: 11 } },
        },
      },
    },
  });
}

/**
 * Render tabel pemakaian per meja.
 */
function renderStatsMejaTable() {
  const tbody     = el.statsMejaTableBody();
  const noDataMsg = el.noDataMejaMsg();
  if (!tbody) return;

  const mejaIds    = ["M1","M2","M3","M4","M5"];
  const adaData    = mejaIds.some(id => state.statsMeja[id] != null);

  if (!adaData) {
    tbody.innerHTML = "";
    if (noDataMsg) noDataMsg.style.display = "";
    return;
  }

  if (noDataMsg) noDataMsg.style.display = "none";

  tbody.innerHTML = mejaIds.map(id => {
    const d = state.statsMeja[id] || {};
    return `<tr>
      <td><strong>${esc(id)}</strong></td>
      <td>${esc(String(d.giliran ?? "—"))}</td>
      <td>${esc(fmtMenit(d.rata_lama_menit))}</td>
      <td>${esc(fmtPct(d.persen_terisi))}</td>
    </tr>`;
  }).join("");
}

/**
 * Perbarui label "Statistik dihitung pada ...".
 */
function renderStatsUpdated() {
  const lbl = el.statsUpdatedLabel();
  if (!lbl) return;
  if (!state.statsUpdated) {
    lbl.textContent = "";
    return;
  }
  const d = new Date(state.statsUpdated);
  lbl.textContent = `Statistik dihitung pada: ${d.toLocaleString("id-ID")}`;
}

// ============================================================
// Controller — Auth & Tab
// ============================================================

/**
 * Terjemahkan kode error Firebase Auth ke bahasa Indonesia.
 * @param {string} code - error.code dari Firebase
 * @returns {string}
 */
function terjemahkanErrorAuth(code) {
  switch (code) {
    case "auth/invalid-email":
      return "Format email tidak valid.";
    case "auth/user-not-found":
    case "auth/wrong-password":
    case "auth/invalid-credential":
      return "Email atau kata sandi salah.";
    case "auth/too-many-requests":
      return "Terlalu banyak percobaan login. Coba lagi beberapa saat.";
    case "auth/network-request-failed":
      return "Gagal terhubung ke jaringan. Periksa koneksi internet.";
    case "auth/user-disabled":
      return "Akun ini telah dinonaktifkan.";
    default:
      return `Login gagal (${code}). Coba lagi.`;
  }
}

/**
 * Tampilkan atau sembunyikan pesan error login.
 * @param {string|null} msg - null untuk menyembunyikan
 */
function setLoginError(msg) {
  const el_err = el.loginError();
  if (!el_err) return;
  if (msg) {
    el_err.textContent = msg;
    el_err.classList.remove("hidden");
  } else {
    el_err.classList.add("hidden");
  }
}

/**
 * Inisialisasi semua event listener UI.
 * Dipanggil sekali setelah DOM siap.
 */
function initUI() {
  // --- Tab switching ---
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.tab;

      // Aktifkan tombol tab
      document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");

      // Tampilkan panel tab
      document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
      const panel = document.getElementById(`panel-${target}`);
      if (panel) panel.classList.add("active");
    });
  });

  // --- Toggle grafik hari kerja / akhir pekan ---
  const btnKerja      = el.chartToggleKerja();
  const btnAkhirPekan = el.chartToggleAkhirPekan();

  if (btnKerja) {
    btnKerja.addEventListener("click", () => {
      chartMode = "kerja";
      btnKerja.classList.add("active");
      if (btnAkhirPekan) btnAkhirPekan.classList.remove("active");
      renderStatsChart();
    });
  }

  if (btnAkhirPekan) {
    btnAkhirPekan.addEventListener("click", () => {
      chartMode = "akhir_pekan";
      btnAkhirPekan.classList.add("active");
      if (btnKerja) btnKerja.classList.remove("active");
      renderStatsChart();
    });
  }

  // --- Login form ---
  const loginBtn = el.loginBtn();
  if (loginBtn) {
    loginBtn.addEventListener("click", async () => {
      const email    = el.loginEmail()?.value.trim()    || "";
      const password = el.loginPassword()?.value || "";

      if (!email || !password) {
        setLoginError("Email dan kata sandi tidak boleh kosong.");
        return;
      }

      setLoginError(null);
      loginBtn.disabled    = true;
      loginBtn.textContent = "Masuk...";

      try {
        await signInWithEmailAndPassword(auth, email, password);
        // onAuthStateChanged akan menangani perubahan UI
      } catch (err) {
        setLoginError(terjemahkanErrorAuth(err.code));
      } finally {
        loginBtn.disabled    = false;
        loginBtn.textContent = "Masuk";
      }
    });

    // Tekan Enter di field kata sandi = klik tombol Masuk
    el.loginPassword()?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") loginBtn.click();
    });
  }

  // --- Logout ---
  const logoutBtn = el.logoutBtn();
  if (logoutBtn) {
    logoutBtn.addEventListener("click", async () => {
      await signOut(auth);
      // onAuthStateChanged menangani UI
    });
  }

  // --- Auth state listener ---
  onAuthStateChanged(auth, (user) => {
    state.currentUser = user;
    if (user) {
      renderStatsLoggedIn(user);
    } else {
      renderLoginForm();
    }
  });
}

// ============================================================
// Bootstrap — dijalankan saat DOM siap
// ============================================================

function main() {
  // Tampilkan loading awal di tab Denah
  const container = el.denahContainer();
  if (container) {
    container.innerHTML = `
      <div class="state-box">
        <div class="spinner" role="status" aria-label="Memuat data..."></div>
        <p class="state-box__title">Memuat data...</p>
        <p class="state-box__msg">Menghubungkan ke Firebase Realtime Database</p>
      </div>`;
  }

  // Mulai listener data denah (tidak butuh login)
  startDenahListeners();

  // Inisialisasi semua event handler UI
  initUI();
}

// Tunggu DOM siap baru jalankan
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", main);
} else {
  main();
}

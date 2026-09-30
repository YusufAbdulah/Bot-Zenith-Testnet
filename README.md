# 🚀 Zenith EVM Testnet Bot

> **Created by [Yusuf Abdullah](https://github.com/YusufAbdulah)**

Bot otomatis untuk klaim faucet, membuat wallet, dan cek saldo di Zenith EVM Testnet.

---

## 🌐 Zenith Testnet Live

### Add Network (MetaMask)

| Parameter    | Value                                     |
|--------------|-------------------------------------------|
| **RPC**      | `https://rpc.testnet.zenith.network/`     |
| **Chain ID** | `936485`                                  |
| **Symbol**   | `ZTH`                                     |
| **Explorer** | https://explorer.testnet.zenith.network/  |

### 🔗 Links

- 🚰 **Faucet**: https://explorer.testnet.zenith.network/faucet
- 📖 **Full Details**: https://zenith.network/resources/blog/introducing-the-zenith-evm-testnet
- 📢 **Source**: https://x.com/ZenithFdn/status/2104511470310420502

---

## 📋 Fitur Bot

```text
[1] Create EVM Wallet
[2] Claim Faucet (Auto Running)
[3] Cek Balance $ZTH
[q] Quit
```

| Menu | Fungsi |
|------|--------|
| **[1] Create Wallet** | Buat 1–100 wallet EVM baru secara otomatis |
| **[2] Claim Faucet** | Klaim faucet ZTH otomatis untuk semua alamat, auto-loop setelah cooldown |
| **[3] Cek Balance** | Cek saldo native ZTH semua wallet sekaligus |

---

## 📦 Persyaratan

- **Node.js** versi `22.19` atau lebih baru — [Download Node.js](https://nodejs.org/)
- **Git** (untuk clone repo) — [Download Git](https://git-scm.com/)

---

## 📖 Tutorial Instalasi & Penggunaan

### Step 1 — Clone Repository

```bash
git clone https://github.com/YusufAbdulah/bot-zenith-testnet.git
cd bot-zenith-testnet
```

### Step 2 — Install Dependencies

```bash
npm install
```

### Step 3 — Jalankan Bot

```bash
npm start
```

Bot akan menampilkan menu interaktif di terminal.

---

## 🔧 Cara Pakai Setiap Menu

### ✅ Menu [1] — Create EVM Wallet

1. Pilih `1` lalu tekan Enter
2. Masukkan jumlah wallet yang ingin dibuat (1–100)
3. Bot akan otomatis:
   - Generate wallet baru (mnemonic, private key, address)
   - Simpan ke `akun.json`
   - Tambahkan address ke `address.txt`

> ⚠️ **Penting:** File `akun.json` berisi **private key & mnemonic** dalam teks biasa. Jangan pernah dibagikan! Gunakan wallet ini untuk **testnet saja**.

### ✅ Menu [2] — Claim Faucet (Auto)

1. Pilih `2` lalu tekan Enter
2. Bot membaca semua alamat dari `address.txt`
3. Klaim dilakukan satu per satu secara berurutan
4. Setelah semua alamat diklaim, bot **otomatis menunggu cooldown** lalu klaim ulang
5. Ketik `q` lalu Enter untuk kembali ke menu utama

> 💡 **Tips:** Biarkan terminal terbuka agar bot terus berjalan otomatis.

### ✅ Menu [3] — Cek Balance $ZTH

1. Pilih `3` lalu tekan Enter
2. Bot akan menampilkan saldo ZTH dari semua alamat di `address.txt`
3. Tekan Enter untuk kembali ke menu

---

## 🌐 Proxy (Opsional)

Jika ingin menggunakan proxy, buat file `proxy.txt` di folder bot dengan satu proxy per baris:

```text
# Format yang didukung:
127.0.0.1:8080
127.0.0.1:8080:user:password
http://user:password@proxy.example:8080
https://proxy.example:8443
socks5://user:password@proxy.example:1080
```

### Cara Kerja Proxy

| Fitur | Keterangan |
|-------|------------|
| **Rotasi otomatis** | Proxy digilir ke semua address secara merata |
| **Rate limit** | Maks 10 klaim per proxy dalam 3 menit |
| **Auto cooldown** | Proxy yang kena HTTP 429 otomatis dijeda |
| **Auto remove** | Proxy gagal/mati otomatis dihapus dari `proxy.txt` |
| **State persist** | Cooldown & hitungan klaim tersimpan walau bot direstart |

> Tanpa `proxy.txt` (atau file kosong), bot jalan dengan koneksi langsung tanpa proxy.

---

## 📁 Struktur File

```
bot-zenith-testnet/
├── bot.mjs          # Main bot (menu, faucet claim, wallet, balance)
├── proxy.mjs        # Proxy pool & rotation logic
├── package.json     # Dependencies & scripts
├── .gitignore       # Mengecualikan file sensitif dari git
├── LICENSE          # MIT License
├── README.md        # Dokumentasi ini
│
├── akun.json        # 🔒 Auto-generated (private key & mnemonic)
├── address.txt      # 🔒 Auto-generated (daftar alamat wallet)
└── proxy.txt        # 🔒 Optional (daftar proxy)
```

> File yang ditandai 🔒 tidak akan ter-upload ke GitHub (sudah masuk `.gitignore`).

---

## ❓ FAQ

<details>
<summary><b>Bot error "address.txt belum ada"</b></summary>

Gunakan Menu **[1]** untuk membuat wallet terlebih dahulu, atau buat file `address.txt` manual dengan satu alamat `0x...` per baris.
</details>

<details>
<summary><b>Berapa lama cooldown antar klaim?</b></summary>

Cooldown mengikuti respons server (saat ini sekitar **30 menit** per alamat). Bot otomatis menunggu dan klaim ulang.
</details>

<details>
<summary><b>Apakah aman untuk dipakai?</b></summary>

Bot ini hanya untuk **testnet**. Bot tidak mengirim transaksi dan tidak membutuhkan private key untuk klaim faucet. Namun file `akun.json` berisi private key, jadi jaga kerahasiaannya.
</details>

<details>
<summary><b>Bisa pakai di VPS/Linux?</b></summary>

Bisa! Pastikan Node.js 22.19+ sudah terpasang. Perintah sama: `npm install` lalu `npm start`.
</details>

---

## 📄 License

[MIT License](LICENSE) — Bebas digunakan, dimodifikasi, dan didistribusikan.

---

<p align="center">
  <b>⭐ Jangan lupa kasih Star kalau repo ini membantu! ⭐</b>
</p>

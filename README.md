# Zenith EVM Testnet Bot

> **Created by [Yusuf Abdullah](https://github.com/YusufAbdulah)**

Bot otomatis untuk klaim faucet, membuat wallet, dan cek saldo di Zenith EVM Testnet.

---

## 🌐 Zenith Testnet Live

### Add Network (MetaMask)

| Parameter  | Value                                        |
|------------|----------------------------------------------|
| **RPC**    | `https://rpc.testnet.zenith.network/`        |
| **Chain ID** | `936485`                                   |
| **Symbol** | `ZTH`                                        |
| **Explorer** | https://explorer.testnet.zenith.network/   |

### 🔗 Links

- 🚰 **Faucet**: https://explorer.testnet.zenith.network/faucet
- 📖 **Full Details**: https://zenith.network/resources/blog/introducing-the-zenith-evm-testnet
- 📢 **Source**: https://x.com/ZenithFdn/status/2104511470310420502

---

Menu bot:

```text
[1] Create EVM Wallet
[2] Claim Faucet (Running)
[3] Cek Balance $ZTH
[q] Quit
```

Perlu Node.js 22.19+. `npm install` memasang `ethers` untuk pembuatan wallet, `chalk` untuk log berwarna, dan `undici` untuk proxy. Jalankan dari folder ini:

```powershell
npm install
npm start
```

Menu **[1]** meminta jumlah wallet (1–100), lalu menambahkan mnemonic, private key, dan address ke `akun.json`. Alamat baru juga ditambahkan ke `address.txt`. File `akun.json` berisi rahasia wallet dalam teks biasa: simpan hanya di perangkat pribadi, jangan bagikan, dan gunakan wallet ini untuk testnet saja. Bot tidak memakai private key untuk klaim.

Menu **[2]** membaca `address.txt` (satu alamat `0x...` per baris), menghapus duplikat saat dibaca, dan mengklaim secara berurutan. File ini sudah berisi alamat yang Anda pakai pada bot Python. Bot menggunakan `GET /api/faucet` untuk status dan `POST /api/faucet` untuk klaim. Jeda tiap alamat mengikuti JSON respons klaim bila tersedia; jika respons sukses tidak menyebut waktu, bot memakai `cooldownMinutes` dari status (saat diperiksa: 30 menit). State klaim disimpan di `%LOCALAPPDATA%\zenith-faucet\<alamat>.json`, lokasi yang sama dengan bot Python lama. Ketik `q` lalu Enter untuk kembali ke menu. **Hentikan bot Python lama sebelum menjalankan menu [2]** agar tidak ada dua proses mengklaim alamat yang sama.

Menu **[3]** membaca alamat yang sama lalu memeriksa saldo native ZTH melalui RPC `https://rpc.testnet.zenith.network`. Bot memverifikasi chain ID `936485` sebelum meminta saldo. Explorer: https://explorer.testnet.zenith.network.

Layar dibersihkan saat memilih menu dan saat kembali ke menu utama. Setelah menu [1] atau [3], tekan Enter untuk kembali. Menu [2] terus berjalan dan mengulang klaim setelah cooldown setiap alamat sampai Anda mengetik `q` lalu Enter; terminal harus tetap terbuka.

## Proxy (opsional)

Tanpa `proxy.txt`, atau bila file itu kosong saat menu dimulai, bot memakai koneksi langsung. Untuk memakai proxy, buat `proxy.txt` di folder bot dengan satu proxy per baris. Format yang didukung:

```text
127.0.0.1:8080
127.0.0.1:8080:user:password
http://user:password@proxy.example:8080
https://proxy.example:8443
socks5://user:password@proxy.example:1080
```

Proxy dibagikan ke address secara bergiliran bila jumlah address lebih banyak. Bot membatasi **maksimal 10 percobaan POST klaim per proxy dalam jendela 3 menit**. Respons HTTP 429 yang jelas menyebut **IP/proxy** memberi proxy tersebut cooldown minimal 3 menit (lebih lama bila server meminta), kemudian bot mencoba proxy lain. Setelah 429 dari beberapa proxy berbeda, bot menjeda seluruh klaim. Respons seperti `This address already claimed` hanya menjeda **address itu** sesuai `retryAfterSeconds` dari JSON, lalu bot lanjut ke address berikutnya tanpa merotasi proxy. Bila penyebab 429 tidak jelas, bot menjeda address tersebut tanpa menganggap proxy rusak. Proxy yang gagal koneksi atau autentikasi dihapus dari `proxy.txt` dan diganti proxy yang masih tersedia.

Hitungan klaim dan cooldown proxy disimpan di `%LOCALAPPDATA%\zenith-faucet\proxy-rate.json`, sehingga batas 3 menit tetap berlaku setelah bot direstart. File state ini memakai hash proxy dan tidak menyimpan kredensialnya. Versi ini membersihkan cooldown proxy yang keliru dari state bot lama saat pertama kali dibaca, tanpa menghapus hitungan klaim.

Jika semua proxy sedang cooldown atau mencapai batas, address menunggu waktu terdekat. Jika semua proxy terhapus, bot menunggu Anda menambahkan proxy baru dan **tidak** berpindah ke koneksi langsung. Menu saldo juga memakai proxy yang tersedia. `proxy.txt` dapat berisi kredensial dan sudah masuk `.gitignore`.

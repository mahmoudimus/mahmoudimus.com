+++
Title: A drone that wouldn't update, and the DJI logs that wouldn't talk
Slug: decrypting-dji-assistant-logs
Date: 2026-07-13
Status: draft
Author: Mahmoud
Tags: reverse engineering, dji, drones, macos, aes, cryptography, ida pro
Classification: blog
Excerpt: A DJI FPV firmware update kept failing with an opaque 5-0-4 error. Reverse-engineering DJI Assistant 2's encrypted logs turned it into a concrete answer: an FTP login failure caused by a marginal USB-C cable.
+++

# A drone that wouldn't update, and the DJI logs that wouldn't talk

*Content warning: liberal amounts of x86 assembly, Qt, and one very stubbornly null-terminated encryption key.*

## Intro

This did not start as a reverse-engineering project. It started as a Sunday-afternoon chore: update the firmware on a DJI FPV drone. Plug it in, open **DJI Assistant 2**, click the button, done. That was the plan.

Instead I got this:

```
DJI FPV Drone: Transfer failed. (5-0-4)
```

0%. Every time. It failed on a brand-new Apple-Silicon Mac running the latest macOS and, as I found later, on an old Windows box too. The interesting part was not the failed update itself. Somewhere between "click update" and "Transfer failed," DJI's software knew exactly what went wrong, wrote it to a log file, and encrypted the file so I could not read it.

## Setting the stage

DJI Assistant 2 (the "Consumer Drones Series" build) is a hefty Electron-fronted app with a native backend. Everything interesting lives in a handful of Mach-O binaries. They are all **x86_64**, so on Apple Silicon the app runs under Rosetta 2:

```
DJIService        13M  x86_64   # the daemon that actually talks to the drone
DJIServiceCore    7.8M x86_64
DJILog.framework  ...  x86_64   # <- the reason I'm here
libcrypto.3.dylib / libssl.3.dylib
libcurl.4.dylib
```

Before the drone talks IP, it needs a USB RNDIS driver so it appears as a USB-Ethernet device. On modern macOS, that means the long-abandoned **HoRNDIS** kext, which refuses to load on macOS 26:

```
Malformed vtable. Super class 'IOEthernetController' has 400 entries
vs subclass 'HoRNDIS' with 394 entries
```

A C++ ABI mismatch caused it: Apple added six virtual methods to `IOEthernetController`, so a kext compiled in 2018 against the old vtable could not link into the new kernel. A community fork rebuilt against a current SDK fixed that. The drone appeared on the bus as `en7 -> 192.168.42.3`, received a DHCP lease from `192.168.42.2`, and answered pings and FTP connections with `220 Hello!`. The link was solid.

And still: `Transfer failed. (5-0-4)`.

## What is a 5-0-4, anyway?

DJI's error codes are opaque triples, so I asked the binary. `DJIService` links Qt, and a quick symbol search found an FTP state machine:

```
DJIFtpFileGetter::OnFtpCommandFinished(int, bool)
[OnFtpCommandFinished] cmd = %1, error = %2  bool error= %3
QFtpPrivate::_q_piFtpReply(int, QString const&)
```

So the firmware transfer is plain old **Qt `QFtp`**. Decompiling `OnFtpCommandFinished` shows a `switch` on `QFtp::currentCommand()`, and every failure branch stamps out a JSON object with `ERROR_TYPE_CODE` and `ERROR_SUB_CODE`. Mapping the Qt `QFtp::Command` enum (`3=ConnectToHost, 4=Login, 6=List, 8=Get, 9=Put`), the `Login` case is unambiguous:

```c
// case 4u:  (QFtp::Login) - after 5 retries
DJILogger::DJILogger(v84, &v91, v93, v90, 513, 0);
std::__put_character_sequence(v68, "login error", 11);      // <- literally
...
QJsonValue::QJsonValue((QJsonValue *)v84, 5);               // ERROR_TYPE_CODE = 5
v93[0] = QString::fromAscii_helper("ERROR_TYPE_CODE", 15);
...
QJsonValue::QJsonValue((QJsonValue *)v84, 4);               // ERROR_SUB_CODE  = 4
v93[0] = QString::fromAscii_helper("ERROR_SUB_CODE", 14);
```

`TYPE=5`, `SUB=4`, and the middle `0` is the module (the aircraft). **`5-0-4` is an FTP login failure.** DJI connects to the drone's FTP server, calls `QFtp::login()`, gets rejected, retries five times at two-second intervals (that's the `QTimer::singleShotImpl(2000, ...)` loop), and gives up.

I confirmed it by logging into the drone's FTP server with the credentials Qt sends by default:

```
220 Hello!
> USER anonymous
331 Please specify password
> PASS anonymous@
< 530 Login failed
```

There's the `530`. Now the obvious question: *why* does the drone reject a login it's supposed to accept? DJI writes the answer to its log every time it happens. And DJI encrypts its log.

## The logs that wouldn't talk

DJI Assistant helpfully exports a `.zip` of its logs, and the timestamped `.log` files inside look like this:

```
70 00 80 00 ee b5 2c ea b6 50 bb ca 08 ff fc 65
6a 11 b0 2a 65 89 53 a1 c0 6d bc 4e 9f 24 cb 51 ...
```

The exported logs are binary soup. `strings` on `DJILog.framework` gave away the game: `Empty key`, `Incorrect key length`, an `iv`, and a promising symbol named `WAES_encrypt`. I opened `DJILog` in IDA and followed the crypto.

### A brief, glorious rabbit hole

`WAES_encrypt` turns out to be **white-box AES**:

```c
__int64 WAES_encrypt(u8 *in, u8 *out) {
  return WAES_encrypt_real(in, out, &t_box_enc);  // key baked into a T-box table
}
```

`WAES_encrypt_real` is nine rounds of table lookups over a ~41 KB `t_box_enc`, ShiftRows/MixColumns folded into the tables, key material dissolved into the lookups. Recovering a clean key from white-box AES is, by design, a bad afternoon.

![I'm not touching this](https://i.kym-cdn.com/photos/images/newsfeed/000/234/765/b7e.jpg)

I did not have to recover it. `WAES_encrypt` has exactly **one** caller, `GetPublicValue`, which encrypts and hex-encodes a single 16-byte block. It is a handshake helper, not the log encryptor. For the logs, the white-box AES was a distraction. The actual write path was elsewhere.

### Following the bytes to disk

The log writer is `DJILogger::WriteLogToFile -> push_log_stream(fstream&, string&)`, and the interesting line in `push_log_stream` is a call to a much friendlier function:

```c
aesEncode((QByteArray *)&v62, (const QString *)&v59);   // encrypt one log line
...
// record framing written to the file:
std::ostream::write(stream, &plaintext_len, 2);   // uint16 LE
std::ostream::write(stream, &cipher_len,    2);   // uint16 LE
std::ostream::write(stream, cipher_data, cipher_len);
```

The file is a sequence of **`[plaintext_len:u16][cipher_len:u16][ciphertext]`** records. `aesEncode` is where the key lives:

```c
const QByteArray *aesEncode(QByteArray *out, const QString *plaintext, const QString *keyStr) {
  AesClass *aes = new AesClass();
  memset(key32, 0x5F, 32);                     // 32 bytes of '_'
  std::string k = keyStr->toStdString();
  int n = min(32, k.size());
  memcpy(key32, k.data(), n);                  // overwrite front with the key string
  AesClass::InitializePrivateKey(aes, 0x20, key32);   // AES-256
  AesClass::OnAesEncrypt(aes, plaintext.data(), plaintext.len(), out.data());
  ...
}
```

Two things fall out of this immediately:

1. It's **AES-256**, and the key is a 32-byte buffer pre-filled with `0x5F` (`'_'`), with the first *N* bytes overwritten by some key string. If that string is short, the tail is just underscores.
2. `OnAesEncrypt` calls `Aes::Cipher` on each 16-byte block **independently**, with no chaining or IV. That is **ECB**, plus a trailing padding block. It explains why `cipher_len` is always the plaintext rounded up to 16, plus 16.

Standard AES-256-ECB. All I need is the key string.

### The key, obfuscated

The key string is not a constant. `push_log_stream` builds it at runtime by appending a fixed byte sequence to a scratch buffer, then running a deobfuscation loop:

```c
// the appended constant bytes (seed 126, 11, then 23 more):
buf = [126, 11, 119, 149, 67, 65, 93, 204, 184, 100, 230, 216, 144,
       213, 218, 225, 118, 246, 11, 108, 207, 45, 192, 56, 173]

// the deobfuscation, reconstructed from the loop:
for i in range(len(buf)):
    key[i] = ROR8(buf[i], i & 7) ^ xorTable[i % 17]
```

where `xorTable` (17 bytes, pulled straight from the binary) is:

```
1f f6 b8 ca 50 3b 47 ad 8d 04 d8 68 6d cb 13 a0 00
```

Run it, and the bytes resolve into cheerful, unmistakable ASCII:

```
b'asexd12456asdexcvd456987\x00'
```

A 24-character passphrase, `asexd12456asdexcvd456987`, followed by a null terminator.

That null is the whole ballgame, and it cost me a decryption attempt. The key string flows through `QString::fromAscii_helper(buf, strlen(buf))`, and `strlen` stops at the `\x00`. So the key handed to AES is the **24 bytes before the null**, and `aesEncode` then pads it to 32 with `0x5F`. Leave the null in and you get 32 bytes of confident garbage; drop it and pad with underscores and you get:

```
AES-256 key = "asexd12456asdexcvd456987________"
hex          = 6173657864313234353661736465786376643435363938375f5f5f5f5f5f5f5f
```

### Decrypting

With the key, the mode, and the framing, decryption is thirteen lines of Python and one `openssl` call:

```python
import struct, subprocess
KEY = (b"asexd12456asdexcvd456987" + b"\x5f" * 32)[:32]

def decrypt_log(path):
    data = open(path, "rb").read()
    off = 0
    while off + 4 <= len(data):
        plen, clen = struct.unpack_from("<HH", data, off); off += 4
        ct = data[off:off + clen]; off += clen
        pt = subprocess.run(
            ["openssl", "enc", "-aes-256-ecb", "-d", "-nopad", "-K", KEY.hex()],
            input=ct, capture_output=True).stdout[:plen]
        print(pt.decode("utf-8", "replace"))
```

And the soup becomes prose:

```
[2026_07_13 12:46:22.991][DJIServiceMgr   ] DA2 Version info:2.1.40.0.3132 ...
[2026_07_13 12:46:23.168][DJIUavDevice    ] StartGoProc | workPath: /Applications/DJI Assistant 2 ...
[2026_07_13 12:46:24.044][DJIWebFileGetter] [OnFinish]https://.../api/v2/geocoder_service/geoip statusCode=200
```

## Results, and the actual bug

The satisfying part: the decrypted logs didn't just satisfy curiosity, they closed the original case. Scattered through the failed session:

```
[/dev/cu.usbmode] GetSerialNumber failed!!! Error Code: 0xe0
[DJIUpgradeMgr]    set date time to device 0x0801 failure!!!, error code: 230
[Log Export]       connect to ftp timeout!
[GetLogListError]  code-1: 5, code-2: 100, code-3: 1
```

Those are **control-channel** failures over the drone's USB serial interface (`/dev/cu.usbmodem`, the DUML link): reading the serial number failed, setting the device clock failed, and FTP timed out. The low-level commands that put the drone into a proper upgrade state never completed, so when Qt tried to log into the drone's FTP server, the drone was not ready and returned `530`. That is `5-0-4`.

The root cause was mundane: **a bad USB-C cable.** It enumerated the drone correctly (USB 2.0, 480 Mbps, clean pings); it was unquestionably a data cable. But it was too marginal for the sustained upgrade handshake. Swapping in a proper cable fixed the update on the first try. The `5-x-x` FTP-error family in the logs, including the `5-100-4` reports other people had seen, had pointed there all along.

An obsolete driver led to an opaque error code, then a Qt FTP state machine, then an encrypted log, and finally a $3 cable. Reverse engineering rarely follows the question you started with.

## The recovered scheme (tl;dr)

For anyone who lands here trying to read their own DJI Assistant 2 logs:

| Field | Value |
|---|---|
| Cipher | AES-256-ECB, no IV |
| Record framing | `[plaintext_len:u16 LE][cipher_len:u16 LE][ciphertext]` |
| `cipher_len` | plaintext padded up to 16 + a 16-byte trailer |
| Key (ASCII) | `asexd12456asdexcvd456987` (24 bytes) + `0x5F` padding to 32 |
| Key (hex) | `6173657864313234353661736465786376643435363938375f5f5f5f5f5f5f5f` |
| Key obfuscation | `key[i] = ROR8(buf[i], i&7) ^ xorTable[i%17]` in `push_log_stream` |
| `xorTable` | `1f f6 b8 ca 50 3b 47 ad 8d 04 d8 68 6d cb 13 a0 00` |

The full decryptor is a single self-contained Python file (`decode-djilog.py`). It leans on `openssl` for the AES so it has no dependencies, and it'll happily chew through the timestamped `.log` files in any DJI Assistant log export.

If this saves someone from staring at unreadable ciphertext while a drone refuses to update, it was worth writing down. Time to update the batteries.

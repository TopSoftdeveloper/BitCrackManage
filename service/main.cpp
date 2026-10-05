// Windows service port of index.js.
//
// Build the Release|x64 configuration in Visual Studio, then from an elevated
// prompt in the folder that contains cuBitCrack.exe:
//   BitCrackService.exe install
//   BitCrackService.exe uninstall
//
// The service has no console window. Manager output is appended to
// BitCrackManage.log in the same folder as this executable.

#define _WIN32_WINNT 0x0601
#define WIN32_LEAN_AND_MEAN

#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <winhttp.h>
#include <bcrypt.h>
#include <iphlpapi.h>
#include <tlhelp32.h>
#include <shellapi.h>

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>
#include <mutex>
#include <algorithm>

namespace {

const wchar_t* kServiceName = L"BitCrackManage";
const wchar_t* kServiceDisplay = L"BitCrack Manage";
const wchar_t* kExeName = L"cuBitCrack.exe";
const wchar_t* kLogName = L"BitCrackManage.log";

const wchar_t* kDiscordWebhook =
	L"https://discord.com/api/webhooks/1539934841280135211/4c6PIuGvvr-D-HrkhfMTZa2Uxaw2urju7WkVuSwY0t5m7Nm6RabZCPfJSvhjvoUhO5c2";
const wchar_t* kStatusWebhook =
	L"https://discord.com/api/webhooks/1458502651737018533/yU-GkGxttQ8L5wo6VejE9-Gmg48lLo1J4Cs0Y0Osl8u_tPl-LgcX0bouwwMgQmhXCZSc";

const DWORD kRestartMs = 10 * 60 * 1000;
const DWORD kCheckMs = 30 * 1000;
const DWORD kFoundSendMs = 10 * 60 * 1000;
const DWORD kPollMs = 3000;

constexpr bool kFocusMode = false; // true = focus bands, false = full range
constexpr int kFocusPuzzle = 0;    // 71..74, or 0 to rotate
constexpr int kFullPuzzle = 71;    // 71..74, or 0 for the combined range

struct RangeHex {
	int puzzle;
	const char* start;
	const char* end;
};

const RangeHex kPuzzleRanges[] = {
	{ 71, "400000000000000000", "7FFFFFFFFFFFFFFFFF" },
	{ 72, "800000000000000000", "FFFFFFFFFFFFFFFFFFFF" },
	{ 73, "1000000000000000000", "1FFFFFFFFFFFFFFFFFF" },
	{ 74, "2000000000000000000", "3FFFFFFFFFFFFFFFFFF" }
};

const RangeHex kFocusBands[] = {
	{ 71, "52AE7D566CF4200000", "72AE7D566CF4200000" },
	{ 72, "991D14E3BCD35A0000", "D91D14E3BCD35A0000" },
	{ 73, "11B3D07C84B5DCC0000", "19B3D07C84B5DCC0000" },
	{ 74, "20B5DCC63F141200000", "30B5DCC63F141200000" }
};

const char* kFullStart = "400000000000000000";
const char* kFullEnd = "3FFFFFFFFFFFFFFFFFF";

struct U256 {
	uint64_t d[4]; // little-endian limbs

	static int HexVal(char c) {
		if (c >= '0' && c <= '9') return c - '0';
		if (c >= 'a' && c <= 'f') return c - 'a' + 10;
		if (c >= 'A' && c <= 'F') return c - 'A' + 10;
		return -1;
	}

};

int Cmp(const U256& a, const U256& b) {
	for (int i = 3; i >= 0; --i) {
		if (a.d[i] < b.d[i]) return -1;
		if (a.d[i] > b.d[i]) return 1;
	}
	return 0;
}

U256 Add(U256 a, const U256& b) {
	unsigned __int64 carry = 0;
	for (int i = 0; i < 4; ++i) {
		unsigned __int64 x = a.d[i];
		unsigned __int64 sum = x + b.d[i];
		unsigned __int64 withCarry = sum + carry;
		a.d[i] = (uint64_t)withCarry;
		carry = (sum < x || withCarry < sum) ? 1 : 0;
	}
	return a;
}

U256 Sub(U256 a, const U256& b) {
	unsigned __int64 borrow = 0;
	for (int i = 0; i < 4; ++i) {
		unsigned __int64 av = a.d[i];
		unsigned __int64 bv = b.d[i];
		unsigned __int64 result = av - bv - borrow;
		borrow = (av < bv || (borrow && av == bv)) ? 1 : 0;
		a.d[i] = (uint64_t)result;
	}
	return a;
}

bool GetBit(const U256& v, int bit) {
	if (bit < 0 || bit > 255) return false;
	return ((v.d[bit / 64] >> (bit % 64)) & 1ULL) != 0;
}

std::string ToHex64(const U256& v) {
	std::string s(64, '0');
	for (int i = 0; i < 64; ++i) {
		int base = (63 - i) * 4;
		int nibble = 0;
		for (int b = 0; b < 4; ++b) {
			if (GetBit(v, base + b)) nibble |= 1 << b;
		}
		s[i] = "0123456789ABCDEF"[nibble];
	}
	return s;
}

std::string ToHexTrimLower(const U256& v) {
	std::string hex = ToHex64(v);
	size_t i = hex.find_first_not_of('0');
	if (i == std::string::npos) return "0";
	hex = hex.substr(i);
	for (char& c : hex) {
		if (c >= 'A' && c <= 'F') c = (char)(c - 'A' + 'a');
	}
	return hex;
}

U256 ParseHex(const char* text) {
	U256 v{};
	if (!text) return v;
	if (text[0] == '0' && (text[1] == 'x' || text[1] == 'X')) text += 2;
	for (const char* p = text; *p; ++p) {
		int nibble = U256::HexVal(*p);
		if (nibble < 0) continue;
		unsigned __int64 carry = (unsigned __int64)nibble;
		for (int i = 0; i < 4; ++i) {
			unsigned __int64 limb = v.d[i];
			unsigned __int64 next = limb >> 60;
			v.d[i] = (uint64_t)((limb << 4) | carry);
			carry = next;
		}
	}
	return v;
}

U256 One() {
	U256 v{};
	v.d[0] = 1;
	return v;
}

U256 Mod(U256 value, const U256& mod) {
	if (Cmp(mod, U256{}) == 0) return value;
	U256 rem{};
	for (int i = 255; i >= 0; --i) {
		unsigned __int64 carry = 0;
		for (int limb = 0; limb < 4; ++limb) {
			unsigned __int64 next = rem.d[limb] >> 63;
			rem.d[limb] = (uint64_t)((rem.d[limb] << 1) | carry);
			carry = next;
		}
		if (GetBit(value, i)) rem.d[0] |= 1ULL;
		if (Cmp(rem, mod) >= 0) rem = Sub(rem, mod);
	}
	return rem;
}

U256 RandomU256() {
	U256 v{};
	NTSTATUS st = BCryptGenRandom(nullptr, reinterpret_cast<PUCHAR>(v.d), sizeof(v.d), BCRYPT_USE_SYSTEM_PREFERRED_RNG);
	if (st != 0) {
		uint64_t tick = GetTickCount64();
		for (int i = 0; i < 4; ++i) v.d[i] = tick * (0x9E3779B97F4A7C15ULL + (uint64_t)i);
	}
	return v;
}

U256 RandomInRange(const U256& start, const U256& end) {
	U256 span = Add(Sub(end, start), One());
	return Add(start, Mod(RandomU256(), span));
}

std::wstring ExeDir() {
	wchar_t path[MAX_PATH];
	DWORD n = GetModuleFileNameW(nullptr, path, MAX_PATH);
	if (n == 0 || n >= MAX_PATH) return L".";
	std::wstring full(path, n);
	size_t slash = full.find_last_of(L"\\/");
	if (slash == std::wstring::npos) return L".";
	return full.substr(0, slash);
}

std::wstring ExePath() {
	wchar_t path[MAX_PATH];
	DWORD n = GetModuleFileNameW(nullptr, path, MAX_PATH);
	if (n == 0 || n >= MAX_PATH) return L"";
	return std::wstring(path, n);
}

std::string IsoNow() {
	SYSTEMTIME st{};
	GetSystemTime(&st);
	char buf[64];
	sprintf_s(buf, "%04u-%02u-%02uT%02u:%02u:%02u.%03uZ",
		st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond, st.wMilliseconds);
	return buf;
}

std::wstring JoinPath(const std::wstring& dir, const wchar_t* name) {
	if (!dir.empty() && (dir.back() == L'\\' || dir.back() == L'/')) return dir + name;
	return dir + L"\\" + name;
}

void LogRaw(const std::string& line) {
	std::wstring path = JoinPath(ExeDir(), kLogName);
	HANDLE file = CreateFileW(path.c_str(), FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
	if (file == INVALID_HANDLE_VALUE) return;
	DWORD wrote = 0;
	WriteFile(file, line.data(), (DWORD)line.size(), &wrote, nullptr);
	CloseHandle(file);
}

void Logf(const char* fmt, ...) {
	char msg[2048];
	va_list ap;
	va_start(ap, fmt);
	vsnprintf_s(msg, _TRUNCATE, fmt, ap);
	va_end(ap);
	LogRaw("[" + IsoNow() + "] " + msg + "\r\n");
}

void ConsoleWrite(const std::wstring& text) {
	HANDLE out = GetStdHandle(STD_OUTPUT_HANDLE);
	if (!out || out == INVALID_HANDLE_VALUE) return;
	DWORD wrote = 0;
	WriteConsoleW(out, text.c_str(), (DWORD)text.size(), &wrote, nullptr);
}

void AttachParentConsole() {
	if (!AttachConsole(ATTACH_PARENT_PROCESS)) return;
	FILE* stream = nullptr;
	freopen_s(&stream, "CONOUT$", "w", stdout);
	freopen_s(&stream, "CONOUT$", "w", stderr);
}

std::wstring Widen(const std::string& text) {
	if (text.empty()) return L"";
	int n = MultiByteToWideChar(CP_UTF8, 0, text.c_str(), (int)text.size(), nullptr, 0);
	std::wstring out(n, L'\0');
	MultiByteToWideChar(CP_UTF8, 0, text.c_str(), (int)text.size(), out.data(), n);
	return out;
}

std::string Narrow(const std::wstring& text) {
	if (text.empty()) return "";
	int n = WideCharToMultiByte(CP_UTF8, 0, text.c_str(), (int)text.size(), nullptr, 0, nullptr, nullptr);
	std::string out(n, '\0');
	WideCharToMultiByte(CP_UTF8, 0, text.c_str(), (int)text.size(), out.data(), n, nullptr, nullptr);
	return out;
}

std::string JsonEscape(const std::string& text) {
	std::string out;
	out.reserve(text.size() + 16);
	for (unsigned char c : text) {
		switch (c) {
		case '\\': out += "\\\\"; break;
		case '"': out += "\\\""; break;
		case '\n': out += "\\n"; break;
		case '\r': out += "\\r"; break;
		case '\t': out += "\\t"; break;
		default:
			if (c < 0x20) {
				char buf[8];
				sprintf_s(buf, "\\u%04x", c);
				out += buf;
			} else {
				out.push_back((char)c);
			}
			break;
		}
	}
	return out;
}

bool ParseHttpsUrl(const std::wstring& url, std::wstring& host, std::wstring& path) {
	const std::wstring prefix = L"https://";
	if (url.compare(0, prefix.size(), prefix) != 0) return false;
	std::wstring rest = url.substr(prefix.size());
	size_t slash = rest.find(L'/');
	if (slash == std::wstring::npos) {
		host = rest;
		path = L"/";
	} else {
		host = rest.substr(0, slash);
		path = rest.substr(slash);
	}
	size_t colon = host.find(L':');
	if (colon != std::wstring::npos) host = host.substr(0, colon);
	return !host.empty();
}

void PostDiscord(const wchar_t* url, const std::string& message) {
	std::wstring host, path;
	if (!ParseHttpsUrl(url, host, path)) {
		Logf("Discord webhook exception: bad url");
		return;
	}
	std::string body = "{\"content\":\"" + JsonEscape(message) + "\"}";
	HINTERNET session = WinHttpOpen(L"BitCrackManage/1.0", WINHTTP_ACCESS_TYPE_DEFAULT_PROXY, WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
	if (!session) {
		Logf("Discord webhook error: WinHttpOpen %lu", GetLastError());
		return;
	}
	HINTERNET connect = WinHttpConnect(session, host.c_str(), INTERNET_DEFAULT_HTTPS_PORT, 0);
	if (!connect) {
		Logf("Discord webhook error: WinHttpConnect %lu", GetLastError());
		WinHttpCloseHandle(session);
		return;
	}
	HINTERNET request = WinHttpOpenRequest(connect, L"POST", path.c_str(), nullptr, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, WINHTTP_FLAG_SECURE);
	if (!request) {
		Logf("Discord webhook error: WinHttpOpenRequest %lu", GetLastError());
		WinHttpCloseHandle(connect);
		WinHttpCloseHandle(session);
		return;
	}
	const wchar_t* headers = L"Content-Type: application/json\r\n";
	BOOL ok = WinHttpSendRequest(request, headers, (DWORD)-1, (LPVOID)body.data(), (DWORD)body.size(), (DWORD)body.size(), 0);
	if (!ok || !WinHttpReceiveResponse(request, nullptr)) {
		Logf("Discord webhook error: send %lu", GetLastError());
	} else {
		DWORD status = 0;
		DWORD statusSize = sizeof(status);
		WinHttpQueryHeaders(request, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_HEADER_NAME_BY_INDEX, &status, &statusSize, WINHTTP_NO_HEADER_INDEX);
		if (status < 200 || status >= 300) Logf("Discord webhook error: HTTP %lu", status);
	}
	WinHttpCloseHandle(request);
	WinHttpCloseHandle(connect);
	WinHttpCloseHandle(session);
}

std::string FormatGiB(DWORDLONG bytes) {
	double gib = (double)bytes / (1024.0 * 1024.0 * 1024.0);
	char buf[32];
	sprintf_s(buf, "%.2f GiB", gib);
	return buf;
}

std::string PrimaryMac() {
	ULONG size = 0;
	GetAdaptersAddresses(AF_UNSPEC, GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER, nullptr, nullptr, &size);
	std::vector<unsigned char> buffer(size);
	IP_ADAPTER_ADDRESSES* addresses = reinterpret_cast<IP_ADAPTER_ADDRESSES*>(buffer.data());
	if (GetAdaptersAddresses(AF_UNSPEC, GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER, nullptr, addresses, &size) != NO_ERROR) {
		return "unknown";
	}
	for (IP_ADAPTER_ADDRESSES* it = addresses; it; it = it->Next) {
		if (it->OperStatus != IfOperStatusUp) continue;
		if (it->IfType == IF_TYPE_SOFTWARE_LOOPBACK) continue;
		if (it->PhysicalAddressLength != 6) continue;
		bool zero = true;
		for (ULONG i = 0; i < it->PhysicalAddressLength; ++i) {
			if (it->PhysicalAddress[i] != 0) zero = false;
		}
		if (zero) continue;
		char mac[32];
		sprintf_s(mac, "%02x:%02x:%02x:%02x:%02x:%02x",
			it->PhysicalAddress[0], it->PhysicalAddress[1], it->PhysicalAddress[2],
			it->PhysicalAddress[3], it->PhysicalAddress[4], it->PhysicalAddress[5]);
		return mac;
	}
	return "unknown";
}

std::string CpuModel() {
	HKEY key = nullptr;
	if (RegOpenKeyExW(HKEY_LOCAL_MACHINE, L"HARDWARE\\DESCRIPTION\\System\\CentralProcessor\\0", 0, KEY_READ, &key) != ERROR_SUCCESS) {
		return "unknown";
	}
	wchar_t name[256];
	DWORD bytes = sizeof(name);
	DWORD type = 0;
	std::string model = "unknown";
	if (RegQueryValueExW(key, L"ProcessorNameString", nullptr, &type, reinterpret_cast<LPBYTE>(name), &bytes) == ERROR_SUCCESS && type == REG_SZ) {
		std::wstring wide(name);
		size_t start = wide.find_first_not_of(L" \t");
		if (start == std::wstring::npos) wide.clear();
		else {
			size_t end = wide.find_last_not_of(L" \t");
			wide = wide.substr(start, end - start + 1);
		}
		model = Narrow(wide);
	}
	RegCloseKey(key);
	return model.empty() ? "unknown" : model;
}

std::string CpuMhz() {
	HKEY key = nullptr;
	if (RegOpenKeyExW(HKEY_LOCAL_MACHINE, L"HARDWARE\\DESCRIPTION\\System\\CentralProcessor\\0", 0, KEY_READ, &key) != ERROR_SUCCESS) {
		return "unknown";
	}
	DWORD mhz = 0;
	DWORD bytes = sizeof(mhz);
	DWORD type = 0;
	std::string text = "unknown";
	if (RegQueryValueExW(key, L"~MHz", nullptr, &type, reinterpret_cast<LPBYTE>(&mhz), &bytes) == ERROR_SUCCESS && type == REG_DWORD && mhz != 0) {
		char buf[32];
		sprintf_s(buf, "%lu MHz", mhz);
		text = buf;
	}
	RegCloseKey(key);
	return text;
}

std::string StatusMessage(const std::string& nextHex) {
	wchar_t host[MAX_COMPUTERNAME_LENGTH + 1];
	DWORD hostLen = MAX_COMPUTERNAME_LENGTH + 1;
	if (!GetComputerNameW(host, &hostLen)) wcscpy_s(host, L"unknown");

	SYSTEM_INFO info{};
	GetSystemInfo(&info);
	MEMORYSTATUSEX memory{};
	memory.dwLength = sizeof(memory);
	GlobalMemoryStatusEx(&memory);

	std::string text;
	text += "cuBitCrack status: running\n";
	text += "Time: " + IsoNow() + "\n";
	text += "Host: " + Narrow(host) + "\n";
	char cpu[512];
	sprintf_s(cpu, "CPU: %s (%lu cores @ %s)\n", CpuModel().c_str(), info.dwNumberOfProcessors, CpuMhz().c_str());
	text += cpu;
	text += "RAM: " + FormatGiB(memory.ullAvailPhys) + " free / " + FormatGiB(memory.ullTotalPhys) + " total\n";
	text += "MAC: " + PrimaryMac();
	if (!nextHex.empty()) text += "\nNext: " + nextHex;
	return text;
}

struct ActiveRange {
	U256 start;
	U256 end;
	std::string label;
};

const RangeHex* FindRange(const RangeHex* table, size_t count, int puzzle) {
	for (size_t i = 0; i < count; ++i) {
		if (table[i].puzzle == puzzle) return &table[i];
	}
	return nullptr;
}

ActiveRange SelectActiveRange() {
	static int rotation = 0;
	ActiveRange range{};
	if constexpr (!kFocusMode) {
		if constexpr (kFullPuzzle >= 71 && kFullPuzzle <= 74) {
			const RangeHex* item = FindRange(kPuzzleRanges, _countof(kPuzzleRanges), kFullPuzzle);
			range.start = ParseHex(item->start);
			range.end = ParseHex(item->end);
			range.label = "full#" + std::to_string(kFullPuzzle) + " [0x" + ToHexTrimLower(range.start) + ", 0x" + ToHexTrimLower(range.end) + "]";
			return range;
		}
		range.start = ParseHex(kFullStart);
		range.end = ParseHex(kFullEnd);
		range.label = "full [2^70, 2^74)";
		return range;
	}
	int candidates[4];
	int count = 0;
	if constexpr (kFocusPuzzle >= 71 && kFocusPuzzle <= 74) {
		candidates[count++] = kFocusPuzzle;
	} else {
		candidates[0] = 71;
		candidates[1] = 72;
		candidates[2] = 73;
		candidates[3] = 74;
		count = 4;
	}
	int puzzle = candidates[rotation % count];
	rotation += 1;
	const RangeHex* item = FindRange(kFocusBands, _countof(kFocusBands), puzzle);
	range.start = ParseHex(item->start);
	range.end = ParseHex(item->end);
	range.label = "focus#" + std::to_string(puzzle) + " [0x" + ToHexTrimLower(range.start) + ", 0x" + ToHexTrimLower(range.end) + "]";
	return range;
}

std::string WriteProgressFile() {
	ActiveRange range = SelectActiveRange();
	Logf("Active search range: %s", range.label.c_str());
	std::string next = ToHex64(RandomInRange(range.start, range.end));
	std::string body;
	body += "start=" + ToHex64(range.start) + "\n";
	body += "next=" + next + "\n";
	body += "end=" + ToHex64(range.end) + "\n";
	body += "points=256\n";
	body += "compression=compressed\n";
	body += "device=0\n";
	body += "elapsed=0\n";
	body += "stride=" + ToHex64(One()) + "\n";
	std::wstring path = JoinPath(ExeDir(), L"progress.txt");
	HANDLE file = CreateFileW(path.c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
	if (file == INVALID_HANDLE_VALUE) {
		Logf("Failed to write progress.txt: %lu", GetLastError());
		return next;
	}
	DWORD wrote = 0;
	WriteFile(file, body.data(), (DWORD)body.size(), &wrote, nullptr);
	CloseHandle(file);
	return next;
}

std::vector<DWORD> ListCrackerPids() {
	std::vector<DWORD> pids;
	HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
	if (snap == INVALID_HANDLE_VALUE) return pids;
	PROCESSENTRY32W entry{};
	entry.dwSize = sizeof(entry);
	if (Process32FirstW(snap, &entry)) {
		do {
			if (_wcsicmp(entry.szExeFile, kExeName) == 0) pids.push_back(entry.th32ProcessID);
		} while (Process32NextW(snap, &entry));
	}
	CloseHandle(snap);
	return pids;
}

void KillPid(DWORD pid) {
	HANDLE process = OpenProcess(PROCESS_TERMINATE | SYNCHRONIZE, FALSE, pid);
	if (!process) return;
	TerminateProcess(process, 1);
	WaitForSingleObject(process, 2000);
	CloseHandle(process);
}

void KillAllCrackers() {
	for (DWORD pid : ListCrackerPids()) KillPid(pid);
}

std::vector<wchar_t> EnvironmentForChild(const std::wstring& extraDir) {
	wchar_t* block = GetEnvironmentStringsW();
	std::vector<wchar_t> out;
	if (!block) {
		out.push_back(0);
		out.push_back(0);
		return out;
	}
	bool sawPath = false;
	for (wchar_t* p = block; *p; ) {
		std::wstring entry = p;
		p += entry.size() + 1;
		if (_wcsnicmp(entry.c_str(), L"PATH=", 5) == 0) {
			entry = L"PATH=" + extraDir + L";" + entry.substr(5);
			sawPath = true;
		}
		out.insert(out.end(), entry.begin(), entry.end());
		out.push_back(0);
	}
	if (!sawPath) {
		std::wstring entry = L"PATH=" + extraDir;
		out.insert(out.end(), entry.begin(), entry.end());
		out.push_back(0);
	}
	out.push_back(0);
	FreeEnvironmentStringsW(block);
	return out;
}

struct Child {
	HANDLE process = nullptr;
	DWORD pid = 0;
	ULONGLONG started = 0;
};

std::mutex g_childLock;
Child g_child;
HANDLE g_stop = nullptr;
ULONGLONG g_foundSendAt = 0;
ULONGLONG g_foundSize = 0;
bool g_foundReady = false;

void CloseChildHandle() {
	if (g_child.process) {
		CloseHandle(g_child.process);
		g_child.process = nullptr;
	}
	g_child.pid = 0;
}

void StartCracker() {
	std::wstring dir = ExeDir();
	std::wstring exe = JoinPath(dir, kExeName);
	if (GetFileAttributesW(exe.c_str()) == INVALID_FILE_ATTRIBUTES) {
		Logf("Process error: %ls was not found next to the service", kExeName);
		return;
	}
	std::wstring database = JoinPath(dir, L"btc_database.txt");
	if (GetFileAttributesW(database.c_str()) == INVALID_FILE_ATTRIBUTES) {
		Logf("Process error: btc_database.txt was not found next to the service");
		return;
	}
	std::string next = WriteProgressFile();
	// Same arguments as index.js COMMAND_ARGS, plus --continue progress.txt.
	std::wstring command = L"\"" + exe + L"\" -p 256 -i btc_database.txt -o btc_found.txt --continue progress.txt";
	std::vector<wchar_t> commandBuf(command.begin(), command.end());
	commandBuf.push_back(0);

	SECURITY_ATTRIBUTES inherit{};
	inherit.nLength = sizeof(inherit);
	inherit.bInheritHandle = TRUE;
	std::wstring logPath = JoinPath(dir, kLogName);
	HANDLE logFile = CreateFileW(logPath.c_str(), FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE, &inherit, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
	HANDLE nul = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &inherit, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
	BOOL inheritHandles = logFile != INVALID_HANDLE_VALUE && nul != INVALID_HANDLE_VALUE;

	STARTUPINFOW startup{};
	startup.cb = sizeof(startup);
	startup.dwFlags = STARTF_USESHOWWINDOW;
	startup.wShowWindow = SW_HIDE;
	if (inheritHandles) {
		startup.dwFlags |= STARTF_USESTDHANDLES;
		startup.hStdInput = nul;
		startup.hStdOutput = logFile;
		startup.hStdError = logFile;
	}

	std::vector<wchar_t> environment = EnvironmentForChild(dir);
	PROCESS_INFORMATION info{};
	Logf("Command: %s", Narrow(command).c_str());
	BOOL created = CreateProcessW(
		exe.c_str(),
		commandBuf.data(),
		nullptr,
		nullptr,
		inheritHandles,
		CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP | CREATE_UNICODE_ENVIRONMENT,
		environment.data(),
		dir.c_str(),
		&startup,
		&info);
	if (logFile != INVALID_HANDLE_VALUE) CloseHandle(logFile);
	if (nul != INVALID_HANDLE_VALUE) CloseHandle(nul);
	if (!created) {
		Logf("Process error: CreateProcess %lu", GetLastError());
		return;
	}
	CloseHandle(info.hThread);
	{
		std::lock_guard<std::mutex> lock(g_childLock);
		CloseChildHandle();
		g_child.process = info.hProcess;
		g_child.pid = info.dwProcessId;
		g_child.started = GetTickCount64();
	}
	try {
		PostDiscord(kStatusWebhook, StatusMessage(next));
	} catch (...) {
		Logf("Failed to send status webhook");
	}
}

void RestartCracker() {
	{
		std::lock_guard<std::mutex> lock(g_childLock);
		CloseChildHandle();
	}
	KillAllCrackers();
	if (WaitForSingleObject(g_stop, 2000) == WAIT_OBJECT_0) return;
	StartCracker();
}

void NoteChildExit() {
	std::lock_guard<std::mutex> lock(g_childLock);
	if (!g_child.process) return;
	DWORD code = STILL_ACTIVE;
	if (!GetExitCodeProcess(g_child.process, &code) || code == STILL_ACTIVE) return;
	if (code == 0xC0000135) {
		Logf("Process exited with code %lu. A required DLL was not found. Install the matching CUDA runtime, then reinstall the service from a prompt whose PATH includes it.", code);
	} else {
		Logf("Process exited with code %lu", code);
	}
	CloseChildHandle();
}

void CheckAndRestart() {
	NoteChildExit();
	std::vector<DWORD> pids = ListCrackerPids();
	if (pids.size() > 1) {
		Logf("Found %u processes running, killing one...", (unsigned)pids.size());
		DWORD tracked = 0;
		{
			std::lock_guard<std::mutex> lock(g_childLock);
			tracked = g_child.pid;
		}
		DWORD victim = pids[0];
		for (DWORD pid : pids) {
			if (pid != tracked) {
				victim = pid;
				break;
			}
		}
		KillPid(victim);
		Logf("Killed process with PID %lu", victim);
		if (victim == tracked) {
			std::lock_guard<std::mutex> lock(g_childLock);
			CloseChildHandle();
		}
		return;
	}
	if (pids.empty()) {
		bool hadHandle = false;
		{
			std::lock_guard<std::mutex> lock(g_childLock);
			hadHandle = g_child.process != nullptr;
			CloseChildHandle();
		}
		if (hadHandle) Logf("Process not running (handle exists but process dead), restarting...");
		else Logf("Process not running, starting...");
		StartCracker();
		return;
	}
	std::lock_guard<std::mutex> lock(g_childLock);
	if (!g_child.process) Logf("Process is running (external), monitoring...");
}

std::string ReadFileRange(const std::wstring& path, ULONGLONG from, ULONGLONG to) {
	if (to <= from) return "";
	HANDLE file = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
	if (file == INVALID_HANDLE_VALUE) return "";
	LARGE_INTEGER pos{};
	pos.QuadPart = (LONGLONG)from;
	if (!SetFilePointerEx(file, pos, nullptr, FILE_BEGIN)) {
		CloseHandle(file);
		return "";
	}
	ULONGLONG length = to - from;
	if (length > 1024 * 1024) length = 1024 * 1024;
	std::string data((size_t)length, '\0');
	DWORD got = 0;
	ReadFile(file, data.data(), (DWORD)data.size(), &got, nullptr);
	CloseHandle(file);
	data.resize(got);
	return data;
}

std::string Trim(const std::string& text) {
	size_t start = 0;
	while (start < text.size() && (text[start] == ' ' || text[start] == '\t' || text[start] == '\r' || text[start] == '\n')) ++start;
	size_t end = text.size();
	while (end > start && (text[end - 1] == ' ' || text[end - 1] == '\t' || text[end - 1] == '\r' || text[end - 1] == '\n')) --end;
	return text.substr(start, end - start);
}

void SendFoundPreview(const std::string& raw) {
	std::string trimmed = Trim(raw);
	if (trimmed.empty()) return;
	std::string preview = trimmed.size() > 1800 ? trimmed.substr(0, 1800) + "\n...[truncated]..." : trimmed;
	Logf("btc_found.txt updated, sending to Discord (%u chars)", (unsigned)trimmed.size());
	PostDiscord(kDiscordWebhook, "You became Millionaire content:\n```\n" + preview + "\n```");
}

void PollFoundFile() {
	std::wstring path = JoinPath(ExeDir(), L"btc_found.txt");
	WIN32_FILE_ATTRIBUTE_DATA info{};
	if (!GetFileAttributesExW(path.c_str(), GetFileExInfoStandard, &info)) return;
	ULONGLONG size = ((ULONGLONG)info.nFileSizeHigh << 32) | info.nFileSizeLow;
	if (!g_foundReady) {
		g_foundReady = true;
		if (size > 0) SendFoundPreview(ReadFileRange(path, 0, size));
		g_foundSize = size;
		return;
	}
	if (size > g_foundSize) {
		ULONGLONG from = g_foundSize;
		g_foundSize = size;
		SendFoundPreview(ReadFileRange(path, from, size));
	} else if (size < g_foundSize) {
		g_foundSize = size;
		if (size > 0) SendFoundPreview(ReadFileRange(path, 0, size));
	}
}

void SendFoundPeriodic() {
	std::wstring path = JoinPath(ExeDir(), L"btc_found.txt");
	std::string content = Trim(ReadFileRange(path, 0, 8ull * 1024ull * 1024ull));
	if (content.empty()) {
		Logf("btc_found.txt is empty, skipping 10-min webhook send");
		return;
	}
	Logf("Sending btc_found.txt content to Discord (%u chars)", (unsigned)content.size());
	const size_t chunkSize = 1900;
	size_t parts = (content.size() + chunkSize - 1) / chunkSize;
	for (size_t index = 0; index < parts; ++index) {
		std::string chunk = content.substr(index * chunkSize, chunkSize);
		std::string header = parts > 1
			? "btc_found.txt data (10-min update) part " + std::to_string(index + 1) + "/" + std::to_string(parts) + ":\n"
			: "btc_found.txt data (10-min update):\n";
		PostDiscord(kDiscordWebhook, header + "```\n" + chunk + "\n```");
	}
}

void EnsureFoundFile() {
	std::wstring path = JoinPath(ExeDir(), L"btc_found.txt");
	HANDLE file = CreateFileW(path.c_str(), GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
	if (file != INVALID_HANDLE_VALUE) CloseHandle(file);
}

bool RestartDue() {
	std::lock_guard<std::mutex> lock(g_childLock);
	if (!g_child.process || g_child.started == 0) return false;
	return GetTickCount64() - g_child.started >= kRestartMs;
}

void RunManager() {
	Logf("Starting %ls manager...", kExeName);
	EnsureFoundFile();
	Logf("Monitoring btc_found.txt for changes...");
	g_foundSendAt = GetTickCount64();
	CheckAndRestart();

	ULONGLONG lastCheck = GetTickCount64();
	while (WaitForSingleObject(g_stop, kPollMs) == WAIT_TIMEOUT) {
		try {
			PollFoundFile();
			ULONGLONG now = GetTickCount64();
			if (now - g_foundSendAt >= kFoundSendMs) {
				g_foundSendAt = now;
				SendFoundPeriodic();
			}
			if (RestartDue()) {
				Logf("Restart interval elapsed, restarting process...");
				RestartCracker();
				lastCheck = GetTickCount64();
				continue;
			}
			if (now - lastCheck >= kCheckMs) {
				lastCheck = now;
				CheckAndRestart();
			}
		} catch (...) {
			Logf("Error in manager loop");
		}
	}

	Logf("Service stop requested, cleaning up...");
	{
		std::lock_guard<std::mutex> lock(g_childLock);
		CloseChildHandle();
	}
	KillAllCrackers();
	Logf("Cleanup completed");
}

SERVICE_STATUS g_status{};
SERVICE_STATUS_HANDLE g_statusHandle = nullptr;

void ReportState(DWORD state, DWORD waitHint = 0) {
	g_status.dwServiceType = SERVICE_WIN32_OWN_PROCESS;
	g_status.dwCurrentState = state;
	g_status.dwControlsAccepted = (state == SERVICE_START_PENDING) ? 0 : (SERVICE_ACCEPT_STOP | SERVICE_ACCEPT_SHUTDOWN);
	g_status.dwWin32ExitCode = NO_ERROR;
	g_status.dwServiceSpecificExitCode = 0;
	g_status.dwCheckPoint = (state == SERVICE_RUNNING || state == SERVICE_STOPPED) ? 0 : g_status.dwCheckPoint + 1;
	g_status.dwWaitHint = waitHint;
	if (g_statusHandle) SetServiceStatus(g_statusHandle, &g_status);
}

DWORD WINAPI ServiceHandler(DWORD control, DWORD, LPVOID, LPVOID) {
	if (control == SERVICE_CONTROL_STOP || control == SERVICE_CONTROL_SHUTDOWN) {
		ReportState(SERVICE_STOP_PENDING, 15000);
		if (g_stop) SetEvent(g_stop);
	}
	return NO_ERROR;
}

void WINAPI ServiceMain(DWORD, LPWSTR*) {
	g_statusHandle = RegisterServiceCtrlHandlerExW(kServiceName, ServiceHandler, nullptr);
	if (!g_statusHandle) return;
	ReportState(SERVICE_START_PENDING, 10000);
	g_stop = CreateEventW(nullptr, TRUE, FALSE, nullptr);
	if (!g_stop) {
		ReportState(SERVICE_STOPPED);
		return;
	}
	SetCurrentDirectoryW(ExeDir().c_str());
	ReportState(SERVICE_RUNNING);
	RunManager();
	CloseHandle(g_stop);
	g_stop = nullptr;
	ReportState(SERVICE_STOPPED);
}

bool SaveServicePath(SC_HANDLE service, const std::wstring& dir) {
	std::wstring path = L"PATH=" + dir;
	wchar_t existing[32767];
	DWORD n = GetEnvironmentVariableW(L"PATH", existing, 32767);
	if (n > 0 && n < 32767) path += L";" + std::wstring(existing, n);
	std::vector<wchar_t> multi(path.begin(), path.end());
	multi.push_back(0);
	wchar_t cuda[MAX_PATH];
	DWORD cudaLen = GetEnvironmentVariableW(L"CUDA_PATH", cuda, MAX_PATH);
	if (cudaLen > 0 && cudaLen < MAX_PATH) {
		std::wstring entry = L"CUDA_PATH=" + std::wstring(cuda, cudaLen);
		multi.insert(multi.end(), entry.begin(), entry.end());
		multi.push_back(0);
	}
	multi.push_back(0);

	HKEY key = nullptr;
	std::wstring subkey = L"SYSTEM\\CurrentControlSet\\Services\\" + std::wstring(kServiceName);
	if (RegOpenKeyExW(HKEY_LOCAL_MACHINE, subkey.c_str(), 0, KEY_SET_VALUE, &key) != ERROR_SUCCESS) return false;
	LONG result = RegSetValueExW(key, L"Environment", 0, REG_MULTI_SZ, reinterpret_cast<const BYTE*>(multi.data()), (DWORD)(multi.size() * sizeof(wchar_t)));
	RegCloseKey(key);
	UNREFERENCED_PARAMETER(service);
	return result == ERROR_SUCCESS;
}

int InstallService() {
	std::wstring binary = L"\"" + ExePath() + L"\"";
	SC_HANDLE manager = OpenSCManagerW(nullptr, nullptr, SC_MANAGER_CREATE_SERVICE);
	if (!manager) {
		Logf("Install failed: OpenSCManager %lu. Run this from an elevated prompt.", GetLastError());
		ConsoleWrite(L"Install failed. Run BitCrackService.exe install from an elevated prompt.\r\n");
		return 1;
	}
	SC_HANDLE service = CreateServiceW(
		manager,
		kServiceName,
		kServiceDisplay,
		SERVICE_ALL_ACCESS,
		SERVICE_WIN32_OWN_PROCESS,
		SERVICE_AUTO_START,
		SERVICE_ERROR_NORMAL,
		binary.c_str(),
		nullptr,
		nullptr,
		nullptr,
		nullptr,
		nullptr);
	if (!service && GetLastError() == ERROR_SERVICE_EXISTS) {
		service = OpenServiceW(manager, kServiceName, SERVICE_ALL_ACCESS);
		if (service) ChangeServiceConfigW(service, SERVICE_WIN32_OWN_PROCESS, SERVICE_AUTO_START, SERVICE_ERROR_NORMAL, binary.c_str(), nullptr, nullptr, nullptr, nullptr, nullptr, kServiceDisplay);
	}
	if (!service) {
		Logf("Install failed: CreateService %lu", GetLastError());
		ConsoleWrite(L"Install failed. See BitCrackManage.log.\r\n");
		CloseServiceHandle(manager);
		return 1;
	}
	SERVICE_DESCRIPTIONW description{};
	description.lpDescription = const_cast<LPWSTR>(L"Runs cuBitCrack with the BitCrackManage search loop. Logs are written beside the executable.");
	ChangeServiceConfig2W(service, SERVICE_CONFIG_DESCRIPTION, &description);
	SC_ACTION actions[3] = {
		{ SC_ACTION_RESTART, 5000 },
		{ SC_ACTION_RESTART, 5000 },
		{ SC_ACTION_RESTART, 5000 }
	};
	SERVICE_FAILURE_ACTIONSW failure{};
	failure.dwResetPeriod = 24 * 60 * 60;
	failure.cActions = 3;
	failure.lpsaActions = actions;
	ChangeServiceConfig2W(service, SERVICE_CONFIG_FAILURE_ACTIONS, &failure);
	SaveServicePath(service, ExeDir());
	if (!StartServiceW(service, 0, nullptr) && GetLastError() != ERROR_SERVICE_ALREADY_RUNNING) {
		Logf("Service installed but did not start: %lu", GetLastError());
		ConsoleWrite(L"Service installed, but it did not start. See BitCrackManage.log.\r\n");
	} else {
		Logf("Service installed and started");
		ConsoleWrite(L"BitCrackManage service installed and started. Log: BitCrackManage.log\r\n");
	}
	CloseServiceHandle(service);
	CloseServiceHandle(manager);
	return 0;
}

int UninstallService() {
	SC_HANDLE manager = OpenSCManagerW(nullptr, nullptr, SC_MANAGER_CONNECT);
	if (!manager) {
		ConsoleWrite(L"Uninstall failed. Run this from an elevated prompt.\r\n");
		return 1;
	}
	SC_HANDLE service = OpenServiceW(manager, kServiceName, SERVICE_STOP | SERVICE_QUERY_STATUS | DELETE);
	if (!service) {
		ConsoleWrite(L"Service is not installed.\r\n");
		CloseServiceHandle(manager);
		return 0;
	}
	SERVICE_STATUS status{};
	ControlService(service, SERVICE_CONTROL_STOP, &status);
	for (int i = 0; i < 30; ++i) {
		if (!QueryServiceStatus(service, &status)) break;
		if (status.dwCurrentState == SERVICE_STOPPED) break;
		Sleep(500);
	}
	if (!DeleteService(service)) {
		Logf("Uninstall failed: %lu", GetLastError());
		ConsoleWrite(L"Uninstall failed. See BitCrackManage.log.\r\n");
		CloseServiceHandle(service);
		CloseServiceHandle(manager);
		return 1;
	}
	Logf("Service uninstalled");
	ConsoleWrite(L"BitCrackManage service stopped and removed.\r\n");
	CloseServiceHandle(service);
	CloseServiceHandle(manager);
	return 0;
}

int ControlExisting(bool start) {
	SC_HANDLE manager = OpenSCManagerW(nullptr, nullptr, SC_MANAGER_CONNECT);
	if (!manager) {
		ConsoleWrite(L"OpenSCManager failed. Run this from an elevated prompt.\r\n");
		return 1;
	}
	SC_HANDLE service = OpenServiceW(manager, kServiceName, start ? SERVICE_START : (SERVICE_STOP | SERVICE_QUERY_STATUS));
	if (!service) {
		ConsoleWrite(L"Service is not installed. Run BitCrackService.exe install first.\r\n");
		CloseServiceHandle(manager);
		return 1;
	}
	if (start) {
		if (!StartServiceW(service, 0, nullptr) && GetLastError() != ERROR_SERVICE_ALREADY_RUNNING) {
			ConsoleWrite(L"Start failed.\r\n");
			CloseServiceHandle(service);
			CloseServiceHandle(manager);
			return 1;
		}
		ConsoleWrite(L"Service started.\r\n");
	} else {
		SERVICE_STATUS status{};
		ControlService(service, SERVICE_CONTROL_STOP, &status);
		ConsoleWrite(L"Stop requested.\r\n");
	}
	CloseServiceHandle(service);
	CloseServiceHandle(manager);
	return 0;
}

int SelfTest() {
	U256 start = ParseHex("400000000000000000");
	U256 end = ParseHex("7FFFFFFFFFFFFFFFFF");
	const char* expectedStart = "0000000000000000000000000000000000000000000000400000000000000000";
	if (ToHex64(start) != expectedStart) {
		Logf("selftest failed: start hex %s", ToHex64(start).c_str());
		ConsoleWrite(L"selftest failed: start hex\r\n");
		return 1;
	}
	if (ToHexTrimLower(start) != "400000000000000000") {
		ConsoleWrite(L"selftest failed: trim hex\r\n");
		return 1;
	}
	if (ToHexTrimLower(end) != "7fffffffffffffffff") {
		ConsoleWrite(L"selftest failed: end hex\r\n");
		return 1;
	}
	U256 next = RandomInRange(start, end);
	if (Cmp(next, start) < 0 || Cmp(next, end) > 0) {
		ConsoleWrite(L"selftest failed: random range\r\n");
		return 1;
	}
	U256 focus = ParseHex("20B5DCC63F141200000");
	if (ToHexTrimLower(focus) != "20b5dcc63f141200000") {
		ConsoleWrite(L"selftest failed: focus hex\r\n");
		return 1;
	}
	ConsoleWrite(L"selftest ok\r\n");
	Logf("selftest ok");
	return 0;
}

} // namespace

int WINAPI wWinMain(HINSTANCE, HINSTANCE, LPWSTR, int) {
	int argc = 0;
	LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &argc);
	std::wstring command = (argc >= 2) ? argv[1] : L"";
	for (wchar_t& c : command) {
		if (c >= L'A' && c <= L'Z') c = (wchar_t)(c - L'A' + L'a');
	}
	if (!command.empty()) AttachParentConsole();

	int code = 0;
	if (command == L"install") code = InstallService();
	else if (command == L"uninstall" || command == L"remove") code = UninstallService();
	else if (command == L"start") code = ControlExisting(true);
	else if (command == L"stop") code = ControlExisting(false);
	else if (command == L"selftest") code = SelfTest();
	else if (!command.empty()) {
		ConsoleWrite(L"Usage: BitCrackService.exe install | uninstall | start | stop\r\n");
		code = 2;
	} else {
		SERVICE_TABLE_ENTRYW table[] = {
			{ const_cast<LPWSTR>(kServiceName), ServiceMain },
			{ nullptr, nullptr }
		};
		if (!StartServiceCtrlDispatcherW(table)) {
			DWORD error = GetLastError();
			if (error != ERROR_FAILED_SERVICE_CONTROLLER_CONNECT) {
				Logf("StartServiceCtrlDispatcher failed: %lu", error);
			}
		}
	}
	if (argv) LocalFree(argv);
	return code;
}

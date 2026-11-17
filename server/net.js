// Какие IPv4-адреса ноутбука видны телефону.
import os from 'node:os';

/** Типичные подсети точек доступа — их показываем первыми. */
const HOTSPOT_HINTS = [
  { prefix: '192.168.137.', label: 'точка доступа Windows (телефон подключён к ноутбуку)' },
  { prefix: '172.20.10.', label: 'точка доступа iPhone (ноутбук подключён к iPhone)' },
  { prefix: '192.168.43.', label: 'точка доступа Android' },
  { prefix: '10.', label: 'локальная сеть' },
  { prefix: '192.168.', label: 'локальная сеть' },
  { prefix: '172.', label: 'локальная сеть' },
  { prefix: '100.', label: 'Tailscale / CGNAT' },
];

// Виртуальные адаптеры и VPN-туннели: телефон в точке доступа через них не ходит.
const SKIP_NAME = /vEthernet|VirtualBox|VMware|WSL|Hyper-V|Loopback|docker|vbox|^wg|WireGuard|Tailscale|ZeroTier|OpenVPN|VPN|^tun|^tap|Radmin|Hamachi/i;

export function listAddresses() {
  const out = [];
  for (const [ifname, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal) continue;
      if (a.address.startsWith('169.254.')) continue; // нет DHCP — бесполезен
      const hint = HOTSPOT_HINTS.find((h) => a.address.startsWith(h.prefix));
      out.push({
        ifname,
        address: a.address,
        label: hint ? hint.label : 'сеть',
        virtual: SKIP_NAME.test(ifname),
        rank: hint ? HOTSPOT_HINTS.indexOf(hint) : 99,
      });
    }
  }
  out.sort((x, y) => Number(x.virtual) - Number(y.virtual) || x.rank - y.rank);
  return out;
}

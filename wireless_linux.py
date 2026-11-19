"""Acceso de solo lectura a la UAPI inalámbrica de Linux."""

import ctypes
import errno
import fcntl
import json
import os
import re
import socket
import struct
import sys
import time
from enum import IntEnum

# UAPI: include/uapi/linux/{netlink,genetlink,nl80211}.h.
NL_HEADER = struct.Struct("=IHHII")
GENL_HEADER = struct.Struct("=BBH")
ATTR_HEADER = struct.Struct("=HH")
NETLINK_GENERIC = 16
GENL_ID_CTRL = 16
CTRL_CMD_GETFAMILY, CTRL_CMD_NEWFAMILY = 3, 1
CTRL_ATTR_FAMILY_ID, CTRL_ATTR_FAMILY_NAME = 1, 2
NLMSG_ERROR, NLMSG_DONE, NLMSG_OVERRUN = 2, 3, 4
NLM_F_REQUEST, NLM_F_DUMP_INTR, NLM_F_DUMP = 1, 0x10, 0x300

GET_WIPHY, NEW_WIPHY = 1, 3
GET_INTERFACE, NEW_INTERFACE = 5, 7
GET_REG = 31
IFNAME = re.compile(r"[A-Za-z0-9_.][A-Za-z0-9_.-]{0,14}")


class Attr(IntEnum):
    WIPHY = 1
    WIPHY_NAME = 2
    IFINDEX = 3
    IFNAME = 4
    IFTYPE = 5
    WIPHY_BANDS = 22
    SUPPORTED_IFTYPES = 32
    REG_ALPHA2 = 33
    GENERATION = 46
    INTERFACE_COMBINATIONS = 120
    SOFTWARE_IFTYPES = 121
    SPLIT_WIPHY_DUMP = 174
    WIPHY_SELF_MANAGED_REG = 216


class ProbeError(Exception):
    def __init__(self, code):
        self.code = code


def error_code(error):
    if isinstance(error, ProbeError):
        return error.code
    if isinstance(error, TimeoutError) or error.errno == errno.ETIMEDOUT:
        return "probe_timeout"
    if error.errno in (errno.EACCES, errno.EPERM):
        return "permission_denied"
    if error.errno in (errno.ENODEV, errno.ENXIO):
        return "adapter_disconnected"
    if error.errno == errno.ENOBUFS:
        return "snapshot_incomplete"
    return "source_unavailable"


def aligned(size):
    return (size + 3) & ~3


def attribute(kind, data=b""):
    size = ATTR_HEADER.size + len(data)
    return ATTR_HEADER.pack(size, kind) + data + bytes(aligned(size) - size)


def attributes(data):
    cursor = 0
    while cursor < len(data):
        if cursor + ATTR_HEADER.size > len(data):
            raise ProbeError("snapshot_incomplete")
        size, kind = ATTR_HEADER.unpack_from(data, cursor)
        if size < ATTR_HEADER.size or cursor + aligned(size) > len(data):
            raise ProbeError("snapshot_incomplete")
        yield kind & 0x3fff, data[cursor + ATTR_HEADER.size:cursor + size]
        cursor += aligned(size)


def fields(data):
    result = {}
    for kind, value in attributes(data):
        if kind in result:
            raise ProbeError("parse_unsupported")
        result[kind] = value
    return result


def integer(data, kind, width=4):
    value = data.get(kind)
    if value is None:
        return None
    if len(value) != width:
        raise ProbeError("parse_unsupported")
    return struct.unpack("=I" if width == 4 else "=H", value)[0]


def string(data, kind):
    value = data.get(kind)
    if value is None:
        return None
    if not value.endswith(b"\0") or b"\0" in value[:-1]:
        raise ProbeError("parse_unsupported")
    return value[:-1].decode("ascii", errors="replace")


def request(family, command, reply, deadline, payload=b"", dump=False):
    with socket.socket(socket.AF_NETLINK, socket.SOCK_RAW, NETLINK_GENERIC) as channel:
        channel.bind((0, 0))
        # Cada transacción tiene su propio socket, sin suscripciones multicast.
        seq, pid = 1, channel.getsockname()[0]
        body = GENL_HEADER.pack(command, 1, 0) + payload
        flags = NLM_F_REQUEST | (NLM_F_DUMP if dump else 0)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise ProbeError("probe_timeout")
        channel.settimeout(remaining)
        channel.sendto(NL_HEADER.pack(len(body) + NL_HEADER.size, family, flags, seq, pid) + body, (0, 0))
        result = []
        total = 0
        while (remaining := deadline - time.monotonic()) > 0:
            channel.settimeout(remaining)
            packet, _, received_flags, sender = channel.recvmsg(65536)
            total += len(packet)
            if not packet or received_flags & socket.MSG_TRUNC or total > 2 * 1024 * 1024:
                raise ProbeError("snapshot_incomplete")
            if sender != (0, 0):
                raise ProbeError("parse_unsupported")
            cursor = 0
            while cursor < len(packet):
                if cursor + NL_HEADER.size > len(packet):
                    raise ProbeError("snapshot_incomplete")
                size, kind, flags, received_seq, _ = NL_HEADER.unpack_from(packet, cursor)
                if size < NL_HEADER.size or cursor + aligned(size) > len(packet):
                    raise ProbeError("snapshot_incomplete")
                data = packet[cursor + NL_HEADER.size:cursor + size]
                cursor += aligned(size)
                if received_seq != seq:
                    raise ProbeError("parse_unsupported")
                if flags & NLM_F_DUMP_INTR or kind == NLMSG_OVERRUN:
                    raise ProbeError("snapshot_incomplete")
                if kind in (NLMSG_DONE, NLMSG_ERROR):
                    if len(data) < 4:
                        raise ProbeError("snapshot_incomplete")
                    status = struct.unpack_from("=i", data)[0]
                    if status < 0:
                        raise OSError(-status, os.strerror(-status))
                    if status:
                        raise ProbeError("parse_unsupported")
                    if kind == NLMSG_DONE:
                        return result
                    continue
                if kind != family or len(data) < GENL_HEADER.size or data[0] != reply:
                    raise ProbeError("parse_unsupported")
                result.append(fields(data[GENL_HEADER.size:]))
                if not dump:
                    return result
        raise ProbeError("probe_timeout")


def family_id(deadline):
    response = request(GENL_ID_CTRL, CTRL_CMD_GETFAMILY, CTRL_CMD_NEWFAMILY, deadline,
                       attribute(CTRL_ATTR_FAMILY_NAME, b"nl80211\0"))
    family = integer(response[0], CTRL_ATTR_FAMILY_ID, width=2) if response else None
    if not family or family <= GENL_ID_CTRL:
        raise ProbeError("source_unavailable")
    return family


def interfaces(messages):
    result = []
    for row in messages:
        name = string(row, Attr.IFNAME)
        index = integer(row, Attr.IFINDEX)
        phy = integer(row, Attr.WIPHY)
        if name and IFNAME.fullmatch(name) and index and phy is not None:
            result.append({"name": name, "index": index, "phy": phy, "mode": integer(row, Attr.IFTYPE)})
    return result


def combinations(data):
    result = []
    for _, item in attributes(data):
        combo = fields(item)
        limits = []
        for _, entry in attributes(combo.get(1, b"")):
            limit = fields(entry)
            limits.append({"max": integer(limit, 1), "modes": list(fields(limit.get(2, b""))),
                           "unknown": bool(limit.keys() - {1, 2})})
        result.append({"max": integer(combo, 2), "channels": integer(combo, 4), "matchBeacon": 3 in combo,
                       "limits": limits, "unknown": bool(combo.keys() - set(range(1, 8)))
                       or any(integer(combo, key) for key in (5, 6, 7))})
    return result


def radios(messages):
    result = {}
    for msg in messages:
        index = integer(msg, Attr.WIPHY)
        if index is None:
            raise ProbeError("parse_unsupported")
        radio = result.setdefault(index, {"index": index, "bands": {}, "selfManaged": False})
        name = string(msg, Attr.WIPHY_NAME)
        if not name or radio.setdefault("name", name) != name:
            raise ProbeError("snapshot_incomplete")
        generation = integer(msg, Attr.GENERATION)
        if generation is not None and radio.setdefault("generation", generation) != generation:
            raise ProbeError("snapshot_incomplete")
        radio["selfManaged"] |= Attr.WIPHY_SELF_MANAGED_REG in msg
        for key, field in ((Attr.SUPPORTED_IFTYPES, "modes"), (Attr.SOFTWARE_IFTYPES, "softwareModes")):
            if key in msg:
                values = list(fields(msg[key]))
                if radio.setdefault(field, values) != values:
                    raise ProbeError("snapshot_incomplete")
        if Attr.INTERFACE_COMBINATIONS in msg:
            values = combinations(msg[Attr.INTERFACE_COMBINATIONS])
            if radio.setdefault("combinations", values) != values:
                raise ProbeError("snapshot_incomplete")
        for band, data in attributes(msg.get(Attr.WIPHY_BANDS, b"")):
            freqs = radio["bands"].setdefault(band, {})
            # NL80211_BAND_ATTR_FREQS. En un dump split el índice de cada
            # entrada anidada puede empezar de nuevo en cada fragmento.
            for _, data_freq in attributes(fields(data).get(1, b"")):
                freq = fields(data_freq)
                mhz = integer(freq, 1)
                offset = integer(freq, 20) or 0
                if mhz is None:
                    raise ProbeError("parse_unsupported")
                flags = list(freq)
                if freqs.setdefault((mhz, offset), [mhz, offset, flags])[2] != flags:
                    raise ProbeError("snapshot_incomplete")
    for radio in result.values():
        radio.pop("generation", None)
        radio["bands"] = {band: list(values.values()) for band, values in radio["bands"].items()}
    return list(result.values())


def regulation(messages):
    return [{"phy": integer(row, Attr.WIPHY), "country": string(row, Attr.REG_ALPHA2)} for row in messages]


def inventory():
    sources = (("nl80211_interface", GET_INTERFACE, NEW_INTERFACE, interfaces, b""),
               ("nl80211_wiphy", GET_WIPHY, NEW_WIPHY, radios, attribute(Attr.SPLIT_WIPHY_DUMP)),
               ("nl80211_reg", GET_REG, GET_REG, regulation, b""))
    result = {"data": {}, "errors": {}}
    try:
        family = family_id(time.monotonic() + 0.4)
    except (ProbeError, OSError) as error:
        result["errors"] = dict.fromkeys((source for source, *_ in sources), error_code(error))
        return result
    for source, command, reply, decode, payload in sources:
        try:
            result["data"][source] = decode(request(family, command, reply, time.monotonic() + 0.45,
                                                    payload, dump=True))
        except (ProbeError, OSError) as error:
            result["errors"][source] = error_code(error)
    return result


def driver_info(name, index):
    # Linux x86-64: struct ifreq (40 bytes, ifr_data en 16),
    # struct ethtool_drvinfo (196 bytes), include/uapi/linux/{if,ethtool,sockios}.h.
    if os.uname().machine != "x86_64" or struct.calcsize("P") != 8:
        raise ProbeError("source_unavailable")
    if not IFNAME.fullmatch(name) or index <= 0:
        raise ProbeError("parse_unsupported")
    try:
        if socket.if_nametoindex(name) != index:
            raise ProbeError("adapter_disconnected")
        data = ctypes.create_string_buffer(196)
        struct.pack_into("=I", data, 0, 3)  # ETHTOOL_GDRVINFO
        request_data = bytearray(40)
        struct.pack_into("=16s", request_data, 0, name.encode("ascii"))
        struct.pack_into("@P", request_data, 16, ctypes.addressof(data))
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as channel:
            fcntl.ioctl(channel.fileno(), 0x8946, request_data, True)  # SIOCETHTOOL
        if socket.if_nametoindex(name) != index:
            raise ProbeError("adapter_disconnected")
    except OSError as error:
        # if_nametoindex can raise OSError without an errno when a name vanishes.
        if error.errno is None:
            raise ProbeError("adapter_disconnected") from error
        raise
    return {key: data.raw[offset:offset + 32].split(b"\0", 1)[0].decode("ascii", errors="replace")
            for key, offset in (("driver", 4), ("firmware", 68))}


if __name__ == "__main__":
    if sys.argv[1:] == ["inventory"]:
        print(json.dumps(inventory()))
    elif len(sys.argv) == 4 and sys.argv[1] == "driver-info" and re.fullmatch(r"[0-9]{1,10}", sys.argv[3]):
        try:
            print(json.dumps({"data": driver_info(sys.argv[2], int(sys.argv[3]))}))
        except (ProbeError, OSError) as error:
            print(json.dumps({"error": error_code(error)}))
    else:
        sys.exit(2)

import { crc32 } from "node:zlib";

/** DOS date for 1980-01-01, the earliest ZIP timestamp. A fixed stamp keeps the bytes reproducible. */
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
const DOS_TIME = 0;

/**
 * Build a ZIP archive with one stored (uncompressed) file at its root.
 * The output is byte-for-byte deterministic for the same name and content,
 * which WorkStream requires when a preparation is replayed.
 */
export const zipSingleFile = (name: string, content: Buffer): Buffer => {
	const fileName = Buffer.from(name, "utf8");
	if (fileName.length === 0 || fileName.length > 0xffff || name.includes("\\") || name.startsWith("/"))
		throw new Error("zip entry name must be a relative path");
	if (content.length > 0xfffffffe) throw new Error("zip entry is too large for a ZIP32 archive");
	const checksum = crc32(content);

	const local = Buffer.alloc(30);
	local.writeUInt32LE(0x04034b50, 0);
	local.writeUInt16LE(20, 4); // version needed
	local.writeUInt16LE(0x0800, 6); // UTF-8 names
	local.writeUInt16LE(0, 8); // stored
	local.writeUInt16LE(DOS_TIME, 10);
	local.writeUInt16LE(DOS_DATE, 12);
	local.writeUInt32LE(checksum, 14);
	local.writeUInt32LE(content.length, 18);
	local.writeUInt32LE(content.length, 22);
	local.writeUInt16LE(fileName.length, 26);
	local.writeUInt16LE(0, 28);

	const central = Buffer.alloc(46);
	central.writeUInt32LE(0x02014b50, 0);
	central.writeUInt16LE(20, 4); // version made by
	central.writeUInt16LE(20, 6); // version needed
	central.writeUInt16LE(0x0800, 8);
	central.writeUInt16LE(0, 10);
	central.writeUInt16LE(DOS_TIME, 12);
	central.writeUInt16LE(DOS_DATE, 14);
	central.writeUInt32LE(checksum, 16);
	central.writeUInt32LE(content.length, 20);
	central.writeUInt32LE(content.length, 24);
	central.writeUInt16LE(fileName.length, 28);
	// extra length, comment length, disk number, internal attributes stay 0
	central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // regular file, rw-r--r--
	central.writeUInt32LE(0, 42); // local header offset

	const centralOffset = local.length + fileName.length + content.length;
	const centralSize = central.length + fileName.length;
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(1, 8);
	end.writeUInt16LE(1, 10);
	end.writeUInt32LE(centralSize, 12);
	end.writeUInt32LE(centralOffset, 16);

	return Buffer.concat([local, fileName, content, central, fileName, end]);
};

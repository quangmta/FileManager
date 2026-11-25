"""Read-only helpers for standard DTED elevation tiles and text logs."""
import csv
import io
import json
import math
import re
import struct
from datetime import datetime, timezone
from pathlib import Path

DTED_DATA_OFFSET = 80 + 648 + 2700
MAX_DTED_AXIS = 10000
MAX_LOG_RECORDS = 5000


class GeoDataError(ValueError):
    pass


def _angle(value, positive, negative):
    try:
        degrees, minutes, seconds = int(value[:3]), int(value[3:5]), int(value[5:7])
        hemisphere = value[7:8].upper()
    except (ValueError, IndexError):
        raise GeoDataError('Tọa độ UHL không hợp lệ')
    if minutes > 59 or seconds > 59 or hemisphere not in (positive, negative):
        raise GeoDataError('Tọa độ UHL không hợp lệ')
    result = degrees + minutes / 60 + seconds / 3600
    return -result if hemisphere == negative else result


def dted_header(path, max_bytes):
    path = Path(path)
    if path.stat().st_size > max_bytes:
        raise GeoDataError(f'File bản đồ vượt giới hạn đọc {max_bytes} byte')
    with path.open('rb') as stream:
        uhl = stream.read(80)
    if len(uhl) != 80 or uhl[:3] != b'UHL' or uhl[3:4] != b'1':
        raise GeoDataError('Không nhận diện được UHL DTED chuẩn (file .dt2 có thể là định dạng riêng)')
    try:
        lon_count, lat_count = int(uhl[47:51]), int(uhl[51:55])
        lon_interval, lat_interval = int(uhl[20:24]) / 10, int(uhl[24:28]) / 10
    except ValueError:
        raise GeoDataError('Thông số kích thước hoặc khoảng cách trong UHL không hợp lệ')
    if not (2 <= lon_count <= MAX_DTED_AXIS and 2 <= lat_count <= MAX_DTED_AXIS):
        raise GeoDataError('Kích thước lưới DTED nằm ngoài giới hạn hỗ trợ')
    if lon_interval <= 0 or lat_interval <= 0:
        raise GeoDataError('Khoảng cách lưới DTED không hợp lệ')
    origin_lon, origin_lat = _angle(uhl[4:12].decode('ascii','replace'), 'E','W'), _angle(uhl[12:20].decode('ascii','replace'), 'N','S')
    record_size = 12 + 2 * lat_count
    expected_size = DTED_DATA_OFFSET + lon_count * record_size
    if path.stat().st_size < expected_size:
        raise GeoDataError('File DTED bị thiếu hoặc cụt dữ liệu cột')
    lat_step, lon_step = lat_interval / 3600, lon_interval / 3600
    return {
        'origin_latitude': origin_lat, 'origin_longitude': origin_lon,
        'latitude_interval_seconds': lat_interval, 'longitude_interval_seconds': lon_interval,
        'latitude_step': lat_step, 'longitude_step': lon_step,
        'columns': lon_count, 'rows': lat_count, 'record_size': record_size,
        'min_latitude': origin_lat, 'max_latitude': origin_lat + (lat_count - 1) * lat_step,
        'min_longitude': origin_lon, 'max_longitude': origin_lon + (lon_count - 1) * lon_step,
        'bytes': path.stat().st_size,
    }


def _read_column(stream, header, column):
    stream.seek(DTED_DATA_OFFSET + column * header['record_size'])
    record = stream.read(header['record_size'])
    if len(record) != header['record_size'] or record[0] != 0xAA:
        raise GeoDataError(f'Cột DTED {column} không có header hợp lệ')
    stored_checksum = int.from_bytes(record[-4:], 'big')
    actual_checksum = sum(record[:-4]) & 0xFFFFFFFF
    values = []
    for offset in range(8, 8 + 2 * header['rows'], 2):
        raw = int.from_bytes(record[offset:offset + 2], 'big')
        if raw in (0xFFFF, 0x8000):
            values.append(None)
        else:
            magnitude = raw & 0x7FFF
            values.append(-magnitude if raw & 0x8000 else magnitude)
    return values, stored_checksum == actual_checksum


def dted_preview(path, max_bytes, max_side=256):
    header = dted_header(path, max_bytes)
    width = min(max_side, header['columns'])
    height = min(max_side, header['rows'])
    columns = sorted({round(i * (header['columns'] - 1) / max(width - 1, 1)) for i in range(width)})
    rows_north_to_south = [round((height - 1 - i) * (header['rows'] - 1) / max(height - 1, 1)) for i in range(height)]
    grid = [[None] * len(columns) for _ in rows_north_to_south]
    sampled_min = sampled_max = None
    checksum_warnings = 0
    with Path(path).open('rb') as stream:
        for out_x, source_x in enumerate(columns):
            column, checksum_ok = _read_column(stream, header, source_x)
            if not checksum_ok:
                checksum_warnings += 1
            for out_y, source_y in enumerate(rows_north_to_south):
                value = column[source_y]
                grid[out_y][out_x] = value
                if value is not None:
                    sampled_min = value if sampled_min is None else min(sampled_min, value)
                    sampled_max = value if sampled_max is None else max(sampled_max, value)
    return {
        **header, 'grid': grid, 'preview_columns': len(columns), 'preview_rows': len(rows_north_to_south),
        'sampled_min_elevation_m': sampled_min, 'sampled_max_elevation_m': sampled_max,
        'checksum_warning_columns': checksum_warnings,
    }


def dted_elevation(path, latitude, longitude, max_bytes):
    header = dted_header(path, max_bytes)
    if not (header['min_latitude'] <= latitude <= header['max_latitude'] and header['min_longitude'] <= longitude <= header['max_longitude']):
        raise GeoDataError('Tọa độ nằm ngoài phạm vi tile bản đồ')
    row = round((latitude - header['origin_latitude']) / header['latitude_step'])
    column = round((longitude - header['origin_longitude']) / header['longitude_step'])
    with Path(path).open('rb') as stream:
        values, checksum_ok = _read_column(stream, header, column)
    value = values[row]
    return {
        'latitude': header['origin_latitude'] + row * header['latitude_step'],
        'longitude': header['origin_longitude'] + column * header['longitude_step'],
        'row': row, 'column': column, 'elevation_m': value,
        'checksum_valid': checksum_ok,
    }


def _field(data, aliases):
    normalized = {re.sub(r'[^a-z0-9]', '', str(key).casefold()): value for key, value in data.items()}
    for alias in aliases:
        value = normalized.get(re.sub(r'[^a-z0-9]', '', alias.casefold()))
        if value not in (None, ''):
            return value
    return None


def _float(value, low, high):
    try:
        number = float(value)
        return number if math.isfinite(number) and low <= number <= high else None
    except (TypeError, ValueError):
        return None


def _timestamp(value):
    if value in (None, ''):
        return ''
    try:
        if isinstance(value, (int, float)) or str(value).strip().replace('.', '', 1).isdigit():
            numeric = float(value)
            if numeric > 100000000000:
                numeric /= 1000
            return datetime.fromtimestamp(numeric, timezone.utc).isoformat(timespec='seconds')
        raw = str(value).strip().replace('Z', '+00:00')
        return datetime.fromisoformat(raw).isoformat(timespec='seconds')
    except (ValueError, OverflowError, OSError):
        return str(value)[:80]


def _record(data, index, raw=''):
    if not isinstance(data, dict):
        data = {'message': str(data)}
    nested = data.get('position') or data.get('coordinates') or data.get('location')
    if isinstance(nested, dict):
        data = {**data, **nested}
    lat = _float(_field(data, ('latitude','lat','gps_latitude','gps_lat')), -90, 90)
    lon = _float(_field(data, ('longitude','lon','lng','gps_longitude','gps_lon')), -180, 180)
    altitude = _float(_field(data, ('altitude','elevation','height','alt','z')), -12000, 100000)
    time_value = _field(data, ('timestamp','datetime','date_time','recorded_at','time','ts'))
    message = _field(data, ('message','msg','event','type','command','status','name'))
    if not raw:
        try:
            raw = json.dumps(data, ensure_ascii=False, separators=(',',':'))
        except (TypeError, ValueError):
            raw = str(data)
    return {
        'index': index, 'timestamp': _timestamp(time_value), 'latitude': lat, 'longitude': lon,
        'altitude_m': altitude, 'message': str(message if message is not None else '')[:500],
        'raw': str(raw)[:1200],
    }


def parse_log(path, max_bytes, max_records=MAX_LOG_RECORDS):
    path = Path(path)
    if path.stat().st_size > max_bytes:
        raise GeoDataError(f'File log vượt giới hạn đọc {max_bytes} byte')
    text = path.read_text(encoding='utf-8-sig', errors='replace')
    records = []
    total = 0
    structured = False
    suffix = path.suffix.casefold()
    if suffix == '.csv':
        structured = True
        for record in csv.DictReader(io.StringIO(text)):
            total += 1
            if len(records) < max_records:records.append(record)
    elif suffix == '.json':
        try:
            root = json.loads(text)
            if isinstance(root, list):
                source = root
            elif isinstance(root, dict):
                collection = next((root[key] for key in ('records','events','logs','data','items') if isinstance(root.get(key), list)), None)
                source = collection if collection is not None else [root]
            else:
                source = []
            structured = True
            total = len(source)
            records = source[:max_records]
        except json.JSONDecodeError:
            structured = False
    if not structured:
        for line in text.splitlines():
            if not line.strip():
                continue
            total += 1
            try:
                value = json.loads(line)
                record = value if isinstance(value, dict) else {'message': value}
            except json.JSONDecodeError:
                pairs = {key: value.strip('"\'') for key, value in re.findall(r'([A-Za-z_][\w.-]*)\s*[=:]\s*("[^"]*"|\'[^\']*\'|[^,;\s]+)', line)}
                record = pairs if pairs else {'message': line[:500]}
            if len(records) < max_records:records.append(record)
    truncated = total > max_records
    normalized = [_record(record, index, str(record) if isinstance(record, str) else '') for index, record in enumerate(records)]
    return {'records': normalized, 'total_records': total, 'truncated': truncated, 'coordinate_records': sum(r['latitude'] is not None and r['longitude'] is not None for r in normalized)}

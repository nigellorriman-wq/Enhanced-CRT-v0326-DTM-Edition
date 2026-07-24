export function createFloat32GeoTIFF(
  width: number,
  height: number,
  bbox: [number, number, number, number],
  elevationData: Float32Array
): Buffer {
  const numTags = 12;
  const headerSize = 8;
  const ifdSize = 2 + numTags * 12 + 4;
  
  let extraOffset = headerSize + ifdSize;
  const bitsPerSampleOffset = extraOffset; extraOffset += 4;
  const pixelScaleOffset = extraOffset; extraOffset += 24;
  const tiepointOffset = extraOffset; extraOffset += 48;
  const geoKeyDirOffset = extraOffset; extraOffset += 16;
  const dataOffset = Math.ceil(extraOffset / 4) * 4;
  
  const totalSize = dataOffset + width * height * 4;
  const arrayBuffer = new ArrayBuffer(totalSize);
  const view = new DataView(arrayBuffer);
  
  // Header: II (0x4949)
  view.setUint16(0, 0x4949, true);
  view.setUint16(2, 42, true);
  view.setUint32(4, 8, true);
  
  let p = 8;
  view.setUint16(p, numTags, true); p += 2;
  
  function writeTag(tag: number, type: number, count: number, valueOrOffset: number) {
    view.setUint16(p, tag, true);
    view.setUint16(p + 2, type, true);
    view.setUint32(p + 4, count, true);
    view.setUint32(p + 8, valueOrOffset, true);
    p += 12;
  }
  
  writeTag(256, 4, 1, width);                          // ImageWidth
  writeTag(257, 4, 1, height);                         // ImageLength
  writeTag(258, 3, 1, 32);                             // BitsPerSample
  writeTag(259, 3, 1, 1);                              // Compression (None)
  writeTag(262, 3, 1, 1);                              // PhotometricInterpretation (BlackIsZero)
  writeTag(273, 4, 1, dataOffset);                     // StripOffsets
  writeTag(277, 3, 1, 1);                              // SamplesPerPixel
  writeTag(278, 4, 1, height);                         // RowsPerStrip
  writeTag(279, 4, 1, width * height * 4);             // StripByteCounts
  writeTag(339, 3, 1, 3);                              // SampleFormat (3 = IEEE Float)
  writeTag(33550, 12, 3, pixelScaleOffset);            // ModelPixelScaleTag
  writeTag(33922, 12, 6, tiepointOffset);              // ModelTiepointTag
  
  view.setUint32(p, 0, true);
  
  const minX = bbox[0], minY = bbox[1], maxX = bbox[2], maxY = bbox[3];
  const dx = (maxX - minX) / width;
  const dy = (maxY - minY) / height;
  
  view.setFloat64(pixelScaleOffset, dx, true);
  view.setFloat64(pixelScaleOffset + 8, dy, true);
  view.setFloat64(pixelScaleOffset + 16, 0.0, true);
  
  view.setFloat64(tiepointOffset, 0.0, true);
  view.setFloat64(tiepointOffset + 8, 0.0, true);
  view.setFloat64(tiepointOffset + 16, 0.0, true);
  view.setFloat64(tiepointOffset + 24, minX, true);
  view.setFloat64(tiepointOffset + 32, maxY, true);
  view.setFloat64(tiepointOffset + 40, 0.0, true);
  
  const floatData = new Float32Array(arrayBuffer, dataOffset, width * height);
  floatData.set(elevationData);
  
  return Buffer.from(arrayBuffer);
}

export function generateFallbackGeoTIFF(urlStr: string, width = 100, height = 100): Buffer {
  let bbox: [number, number, number, number] = [297000, 675000, 298000, 676000];
  
  const bboxMatch = urlStr.match(/bbox=([0-9.]+),([0-9.]+),([0-9.]+),([0-9.]+)/i);
  if (bboxMatch) {
    const e1 = parseFloat(bboxMatch[1]);
    const n1 = parseFloat(bboxMatch[2]);
    const e2 = parseFloat(bboxMatch[3]);
    const n2 = parseFloat(bboxMatch[4]);
    bbox = [Math.min(e1, e2), Math.min(n1, n2), Math.max(e1, e2), Math.max(n1, n2)];
  } else {
    const eMatch = urlStr.match(/subset=E\(([0-9.]+),([0-9.]+)\)/i);
    const nMatch = urlStr.match(/subset=N\(([0-9.]+),([0-9.]+)\)/i);
    if (eMatch && nMatch) {
      bbox = [parseFloat(eMatch[1]), parseFloat(nMatch[1]), parseFloat(eMatch[2]), parseFloat(nMatch[2])];
    }
  }
  
  const [minX, minY, maxX, maxY] = bbox;
  const data = new Float32Array(width * height);
  
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const x = minX + (c / width) * (maxX - minX);
      const y = maxY - (r / height) * (maxY - minY);
      
      // Topographic model for Scotland (Central Belt / Lothian / Highlands)
      const baseHeight = 45 + Math.sin(x * 0.00005) * 30 + Math.cos(y * 0.00004) * 40;
      const hills = Math.sin(x * 0.003) * Math.cos(y * 0.003) * 12 + Math.sin(x * 0.01 + y * 0.01) * 3;
      const microTerrain = Math.sin(x * 0.05) * Math.cos(y * 0.05) * 0.8;
      
      const elevation = Math.max(2.0, baseHeight + hills + microTerrain);
      data[r * width + c] = elevation;
    }
  }
  
  return createFloat32GeoTIFF(width, height, bbox, data);
}

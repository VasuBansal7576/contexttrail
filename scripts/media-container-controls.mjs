/** Owned, tiny negative inputs for separate recognition and decoder boundaries. */
export function mediaContainerControls() {
  const malformedLayout = Buffer.alloc(20);
  malformedLayout.write('ftyp', 4);
  const atom = (type, payload) => {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(header.length + payload.length);
    header.write(type, 4, 4, 'ascii');
    return Buffer.concat([header, payload]);
  };
  // Recognizable nonempty movie/media atoms, without a video track or usable
  // duration. Recognition may admit this layout; native validation must fail.
  const undecodableLayout = Buffer.concat([
    atom('moov', atom('mvhd', Buffer.alloc(8))),
    atom('mdat', Buffer.from([1, 2, 3])),
  ]);
  return { malformedLayout, undecodableLayout };
}

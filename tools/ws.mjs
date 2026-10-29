/**
 * 极简 WebSocket 服务端（RFC 6455），零依赖。
 *
 * 为什么不用 ws：插件要保持零依赖，而 Node 内置只有 WebSocket 客户端，
 * 没有服务端。这里只实现 hub 需要的部分：文本帧、分片、ping/pong、close，
 * 不做扩展协商（permessage-deflate）。
 */

import http from 'node:http'
import crypto from 'node:crypto'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** 一个 WebSocket 连接（服务端侧）。 */
export class WsConnection {
  constructor(socket, request) {
    this.socket = socket
    this.request = request
    this.closed = false
    this.chunks = []
    this.buffered = 0
    this.fragments = []
    this.handlers = { message: [], close: [] }
    socket.on('data', (chunk) => this._onData(chunk))
    socket.on('close', () => this._finish())
    socket.on('error', () => this._finish())
  }

  onMessage(handler) { this.handlers.message.push(handler) }
  onClose(handler) { this.handlers.close.push(handler) }

  _finish() {
    if (this.closed) return
    this.closed = true
    for (const handler of this.handlers.close) {
      try { handler() } catch { /* ignore */ }
    }
  }

  _onData(chunk) {
    this.chunks.push(chunk)
    this.buffered += chunk.length
    this._parse()
  }

  // 把已缓冲的数据合成一个 Buffer，解析出完整帧后把剩余放回
  _parse() {
    if (this.buffered < 2) return
    let buffer = Buffer.concat(this.chunks, this.buffered)
    this.chunks = []
    this.buffered = 0

    while (buffer.length >= 2) {
      const first = buffer[0]
      const second = buffer[1]
      const fin = (first & 0x80) !== 0
      const opcode = first & 0x0f
      const masked = (second & 0x80) !== 0
      let length = second & 0x7f
      let offset = 2
      if (length === 126) {
        if (buffer.length < 4) break
        length = buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (buffer.length < 10) break
        length = Number(buffer.readBigUInt64BE(2))
        offset = 10
      }
      const maskLength = masked ? 4 : 0
      if (buffer.length < offset + maskLength + length) break

      let payload = buffer.subarray(offset + maskLength, offset + maskLength + length)
      if (masked) {
        const mask = buffer.subarray(offset, offset + 4)
        const unmasked = Buffer.allocUnsafe(length)
        for (let index = 0; index < length; index += 1) unmasked[index] = payload[index] ^ mask[index & 3]
        payload = unmasked
      }
      buffer = buffer.subarray(offset + maskLength + length)
      this._handleFrame(fin, opcode, payload)
      if (this.closed) return
    }

    if (buffer.length) {
      this.chunks = [buffer]
      this.buffered = buffer.length
    }
  }

  _handleFrame(fin, opcode, payload) {
    if (opcode === 0x8) { this.close(); return }
    if (opcode === 0x9) { this._sendFrame(0xa, payload); return }
    if (opcode === 0xa) return
    if (opcode === 0x1 || opcode === 0x2) {
      this.fragments = [payload]
      if (fin) this._message(Buffer.concat(this.fragments))
      return
    }
    if (opcode === 0x0) {
      this.fragments.push(payload)
      if (fin) this._message(Buffer.concat(this.fragments))
    }
  }

  _message(buffer) {
    let text
    try { text = buffer.toString('utf8') } catch { return }
    for (const handler of this.handlers.message) {
      try { handler(text) } catch { /* ignore */ }
    }
  }

  _sendFrame(opcode, payload) {
    if (this.closed) return
    const length = payload.length
    let header
    if (length < 126) {
      header = Buffer.alloc(2)
      header[1] = length
    } else if (length < 65536) {
      header = Buffer.alloc(4)
      header[1] = 126
      header.writeUInt16BE(length, 2)
    } else {
      header = Buffer.alloc(10)
      header[1] = 127
      header.writeBigUInt64BE(BigInt(length), 2)
    }
    header[0] = 0x80 | opcode
    try { this.socket.write(Buffer.concat([header, payload])) } catch { this._finish() }
  }

  /** 发送 JSON（或字符串）。 */
  send(value) {
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    this._sendFrame(0x1, Buffer.from(text, 'utf8'))
  }

  close() {
    if (this.closed) return
    try { this._sendFrame(0x8, Buffer.alloc(0)) } catch { /* ignore */ }
    this.closed = true
    try { this.socket.end() } catch { /* ignore */ }
    for (const handler of this.handlers.close) {
      try { handler() } catch { /* ignore */ }
    }
  }
}

/**
 * 创建带 upgrade 处理的 HTTP 服务。
 * @param {(conn: WsConnection, request: http.IncomingMessage) => void} onConnection
 */
export function createWsServer(onConnection) {
  const server = http.createServer()
  server.on('upgrade', (request, socket) => {
    const key = request.headers['sec-websocket-key']
    if (!key) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
      socket.destroy()
      return
    }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64')
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '',
      '',
    ].join('\r\n'))
    try {
      const conn = new WsConnection(socket, request)
      onConnection(conn, request)
    } catch {
      socket.destroy()
    }
  })
  return server
}

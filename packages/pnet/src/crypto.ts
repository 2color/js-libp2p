import { fromString as uint8ArrayFromString } from 'uint8arrays/from-string'
import { toString as uint8ArrayToString } from 'uint8arrays/to-string'
import xsalsa20 from 'xsalsa20'
import * as Errors from './errors.js'
import { KEY_LENGTH } from './key-generator.js'
import type { Source } from 'it-stream-types'

/**
 * Creates a stream iterable to encrypt messages in a private network
 */
export function createBoxStream (nonce: Uint8Array, psk: Uint8Array): (source: Source<Uint8Array>) => AsyncIterable<Uint8Array> {
  const xor = xsalsa20(nonce, psk)

  return (source: Source<Uint8Array>) => (async function * () {
    for await (const chunk of source) {
      yield Uint8Array.from(xor.update(chunk.slice()))
    }
  })()
}

/**
 * Creates a stream iterable to decrypt messages in a private network
 */
export function createUnboxStream (nonce: Uint8Array, psk: Uint8Array) {
  return (source: Source<Uint8Array>) => (async function * () {
    const xor = xsalsa20(nonce, psk)

    for await (const chunk of source) {
      yield Uint8Array.from(xor.update(chunk.slice()))
    }
  })()
}

/**
 * Decode the version 1 psk from the given Uint8Array
 */
export function decodeV1PSK (pskBuffer: Uint8Array): { tag: string | undefined, codecName: string | undefined, psk: Uint8Array } {
  try {
    // This should pull from multibase/multicodec to allow for
    // more encoding flexibility. Ideally we'd consume the codecs
    // from the buffer line by line to evaluate the next line
    // programmatically instead of making assumptions about the
    // encodings of each line.
    const metadata = uint8ArrayToString(pskBuffer).split(/(?:\r\n|\r|\n)/g)
    const pskTag = metadata.shift()
    const codec = metadata.shift()
    const pskString = metadata.shift()
    const psk = uint8ArrayFromString(pskString ?? '', 'base16')

    if (psk.byteLength !== KEY_LENGTH) {
      throw new Error(Errors.INVALID_PSK)
    }

    return {
      tag: pskTag,
      codecName: codec,
      psk
    }
  } catch (err: any) {
    throw new Error(Errors.INVALID_PSK)
  }
}

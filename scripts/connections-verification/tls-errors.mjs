/** mysql2 将 TLS 原始错误码改写为握手错误；不同 Node 版本的证书错误文本略有差异。 */
export function isUntrustedCertificateError(error) {
  return (
    error?.code === 'HANDSHAKE_SSL_ERROR' &&
    typeof error.message === 'string' &&
    /^(?:self[- ]signed certificate(?: in certificate chain)?|unable to verify (?:the )?first certificate)$/i.test(
      error.message,
    )
  )
}

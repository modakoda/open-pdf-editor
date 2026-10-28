/** The file is encrypted and no password was supplied. */
export class PasswordRequiredError extends Error {
  override name = 'PasswordRequiredError'
  constructor(message = 'This PDF is password protected.') {
    super(message)
  }
}

/** The supplied password does not open the file. */
export class InvalidPasswordError extends Error {
  override name = 'InvalidPasswordError'
  constructor(message = 'The password is incorrect.') {
    super(message)
  }
}

/** The bytes could not be parsed as a PDF. */
export class PdfLoadError extends Error {
  override name = 'PdfLoadError'
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
  }
}

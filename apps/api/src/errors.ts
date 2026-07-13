export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly publicCode: string,
  ) {
    super(publicCode);
  }
}

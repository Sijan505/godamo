/**
 * HTTP errors. The JSON bodies match what the API has always returned
 * (e.g. { message, error: "Not Found", statusCode: 404 }), so existing clients
 * like the Field app keep working.
 */

const REASONS = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
};

export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string | string[] | object} [response] a message, a list of
   *   messages, or a complete response body
   */
  constructor(status, response) {
    super(typeof response === 'string' ? response : (REASONS[status] ?? 'Error'));
    this.status = status;
    if (response && typeof response === 'object' && !Array.isArray(response)) {
      this.body = response;
    } else if (response === undefined) {
      this.body = { message: REASONS[status] ?? 'Error', statusCode: status };
    } else {
      this.body = { message: response, error: REASONS[status], statusCode: status };
    }
  }
}

export const BadRequest = (message) => new HttpError(400, message);
export const Unauthorized = (message) => new HttpError(401, message);
export const Forbidden = (message) => new HttpError(403, message);
export const NotFound = (message) => new HttpError(404, message);
export const Conflict = (message) => new HttpError(409, message);
export const UnprocessableEntity = (message) => new HttpError(422, message);

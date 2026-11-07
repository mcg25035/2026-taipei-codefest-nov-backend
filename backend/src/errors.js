export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const validationError = (message, details) => new ApiError(400, 'VALIDATION_ERROR', message, details);
export const notFound = (message = '找不到資料') => new ApiError(404, 'NOT_FOUND', message);
export const forbidden = (message = '沒有權限') => new ApiError(403, 'FORBIDDEN', message);

export function errorMiddleware(err, req, res, next) {
  if (res.headersSent) return next(err);
  if (err instanceof ApiError) {
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, ...(err.details && { details: err.details }) },
    });
  }
  if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: '請求內容格式錯誤' } });
  }
  console.error(err);
  return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: '伺服器發生錯誤' } });
}

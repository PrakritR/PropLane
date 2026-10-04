/**
 * Upload caps shared by the resident form (client) and the routes that enforce them (server),
 * so the two can never disagree about how many photos a question takes.
 */
export const MAX_FILES_PER_QUESTION = 10;
export const MAX_SIGNATURES_PER_QUESTION = 5;
export const MAX_FILES_PER_FORM = 40;

/**
 * Vercel refuses a request body over 4.5 MB before our code runs, so an image bigger than this can never
 * arrive. The route stops reading at the request cap (it never trusts `content-length` alone) and the
 * browser shrinks a photo to the client cap before upload.
 */
export const MAX_UPLOAD_REQUEST_BYTES = 4_500_000;
export const MAX_CLIENT_IMAGE_BYTES = 4_000_000;
/** The JSON bodies (answers, send) are small; a draft with a few signature paths is far under this. */
export const MAX_JSON_BODY_BYTES = 800_000;
/** A property's original PDF (8 MB cap on the file itself) plus the multipart envelope. */
export const MAX_PDF_UPLOAD_REQUEST_BYTES = 11 * 1024 * 1024;

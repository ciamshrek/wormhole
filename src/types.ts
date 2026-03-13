export interface Handler {
  onRequest?: (req: Request) => Request | Response | Promise<Request | Response>;
  onResponse?: (res: Response, req: Request) => Response | Promise<Response>;
}

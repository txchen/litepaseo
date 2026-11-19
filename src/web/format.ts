/** "/home/me/code/app" or "/Users/me/code/app" → "~/code/app", for paths shown to the reader. */
export const tildeHome = (path: string) => path.replace(/^\/(home|Users)\/[^/]+(?=\/|$)/, "~");

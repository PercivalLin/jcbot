declare module "better-sqlite3" {
  const Database: new (path: string) => any;
  export default Database;
}

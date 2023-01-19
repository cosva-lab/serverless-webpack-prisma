'use strict';
const { readFileSync, writeFileSync } = require('fs');
const { join, posix, sep } = require('path');

function getPrismaDir(cwd, relativeFolderPrisma, relativePrisma) {
  const targetPrismaDir = join(cwd, relativeFolderPrisma);
  const file = join(cwd, 'package.json');
  try {
    const packageJson = JSON.parse(readFileSync(file, 'utf8'));
    if (!packageJson.prisma) {
      // parse relativePrisma to unix path
      const unixRelativePrisma = relativePrisma.replace(
        new RegExp(`\\${sep}`, 'g'),
        posix.sep
      );
      packageJson.prisma = {
        schema: unixRelativePrisma,
      };
    }
    writeFileSync(file, JSON.stringify(packageJson, null, 2));
  } catch {
    // ignore
  }
  return { targetPrismaDir, cwd };
}
exports.getPrismaDir = getPrismaDir;

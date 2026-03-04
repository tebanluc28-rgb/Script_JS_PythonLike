#!/usr/bin/env node
// Wrapper para compatibilidad con pkg
const { spawn } = require('child_process');
const path = require('path');

// Detectar si estamos en un ejecutable pkg
const isPkg = typeof process.pkg !== 'undefined';

if (isPkg) {
  // En ejecutable pkg, los archivos están en el snapshot
  const nodePath = process.execPath;
  const args = [
    path.join(__dirname, 'web_server.js'),
    ...process.argv.slice(2)
  ];

  // Ejecutar node directamente con el archivo
  const child = spawn(nodePath, args, {
    stdio: 'inherit',
    env: { ...process.env }
  });

  child.on('exit', (code) => {
    process.exit(code);
  });
} else {
  // En desarrollo, ejecutar normalmente
  import('./web_server.js').catch(err => {
    console.error(err);
    process.exit(1);
  });
}

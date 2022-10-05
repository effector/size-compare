import babel from '@rollup/plugin-babel';
import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';
import resolve from '@rollup/plugin-node-resolve';

const extensions = ['.ts', '.tsx', '.json'];
const external = []; //['@actions/core', '@actions/github'];

export default {
  input: 'src',
  output: {
    file: 'dist/main.js',
    format: 'cjs',
    sourcemap: true,
  },
  external,
  plugins: [
    babel({extensions, exclude: 'node_modules/**', babelHelpers: 'bundled'}),
    json(),
    resolve({extensions}),
    commonjs({
      include: /node_modules/,
    }),
  ],
};

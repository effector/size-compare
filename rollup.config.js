import babel from '@rollup/plugin-babel';
import commonjs from '@rollup/plugin-commonjs';
import resolve from '@rollup/plugin-node-resolve';

import Package from './package.json';

const extensions = ['.ts', '.tsx', '.json'];

export default {
  input: 'src',
  output: {
    file: 'dist/main.js',
    format: 'cjs',
    sourcemap: true,
  },
  external: Object.keys(Package.dependencies),
  plugins: [
    babel({extensions, exclude: 'node_modules/**', babelHelpers: 'bundled'}),
    resolve({extensions}),
    commonjs(),
  ],
};

// typescript-eslint's recommended rules, with Prettier owning layout (eslint-config-prettier isn't needed: the recommended
// sets have no formatting rules).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(js.configs.recommended, tseslint.configs.recommended, { ignores: ['node_modules/'] });

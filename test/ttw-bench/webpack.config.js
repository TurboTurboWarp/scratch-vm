// Bundle for running TTW-Bench in a browser: node test/../webpack --config test/ttw-bench/webpack.config.js
// Babel only lowers syntax webpack 4 can't parse (?. and ??): Chrome 79 keeps classes, let and generators native.
const path = require('path');
module.exports = {
    mode: 'production',
    target: 'web',
    entry: path.resolve(__dirname, 'browser.js'),
    output: {path: path.resolve(__dirname, 'dist'), filename: 'ttw-bench.js', hashFunction: 'sha256'},
    devtool: false,
    optimization: {minimize: false},
    node: {fs: 'empty', child_process: 'empty'},
    module: {rules: [
        {test: /\.js$/, loader: 'babel-loader', exclude: /node_modules/,
            options: {presets: [['@babel/preset-env', {targets: {chrome: '79'}}]]}},
        {test: /\.mp3$/, loader: 'file-loader', options: {outputPath: 'media/music/'}}
    ]}
};

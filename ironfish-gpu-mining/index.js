/*
This directory is system relative 
*/

var addon = require('/home/hentai8-desktop/Desktop/project/blake3-miner-cuda-to-nodejs/build/Release/addon.node');



/*
The first argument stand for: 
     0 --> Addition
     1 --> Subtract
     2 --> Multiplication
     3 --> Exponential
     4 --> Power
*/

console.log(addon.mine("0000000000000000cf0e020000000000000000000002aaced825176dd9db0701c995760a03a1f42c69b63b4b7d4090b0ff7f32477b07a0cc3c89d6f6335433def2d95ff91be838ae47212ba43794901bb0ce220200000000f6ee7f75663920ae6d8617379629d5130323e6e20c5e19cb5606c71bb97ed7e668d5130100000000000000000007b87e00ba71e3b4a9a27d79dad30a55297da63550092644b289502c8efe8f82010000000000007736f4a168656e7461693800000000000000000000000000000000000000000000000000", "0000000fffffffffffffffffffffffff"));

// console.log(addon.math_func(0, 4, 5));
// console.log(addon.math_func(1, 5, 6));
// console.log(addon.math_func(2, 5, 6));
// //the 3rd argument is Ambiguous
// console.log(addon.math_func(3, 2, 5));
// console.log(addon.math_func(4, 5, 6));


#include <stdio.h>
#include <string.h>
#include <math.h>
#include <string.h>
#include <nan.h>

using v8::Exception;
using v8::FunctionCallbackInfo;
using v8::Isolate;
using v8::Local;
using v8::Number;
using v8::Object;
using v8::String;
using v8::Value;

char *mine(const char *header_string, const char *target_string);

// const char* ToCString(Local<String> str) {
//   String::Utf8Value value(str);
//   return *value ? *value : "<string conversion failed>";
// }

void Mine(const Nan::FunctionCallbackInfo<v8::Value> &info)
{
    v8::Local<v8::Context> context = info.GetIsolate()->GetCurrentContext();

    if (info.Length() != 2)
    {
        Nan::ThrowTypeError("Wrong number of arguments");
        return;
    }
    // Local<String> arg0_value = Local<String>::Cast(info[0]);
    // String::Utf8Value arg0_string(arg0_value);
    // char *arg0 = *arg0_string;

    // Local<String> arg1_value = Local<String>::Cast(info[1]);
    // String::Utf8Value arg1_string(arg1_value);
    // char *arg1 = *arg1_string;

    char *arg0 = "0000000000000000cf0e020000000000000000000002aaced825176dd9db0701c995760a03a1f42c69b63b4b7d4090b0ff7f32477b07a0cc3c89d6f6335433def2d95ff91be838ae47212ba43794901bb0ce220200000000f6ee7f75663920ae6d8617379629d5130323e6e20c5e19cb5606c71bb97ed7e668d5130100000000000000000007b87e00ba71e3b4a9a27d79dad30a55297da63550092644b289502c8efe8f82010000000000007736f4a168656e7461693800000000000000000000000000000000000000000000000000";
    char *arg1 = "0000000fffffffffffffffffffffffff";
    char *res = mine(arg0, arg1);
    v8::MaybeLocal<v8::String> response = Nan::New(res);
    info.GetReturnValue().Set(response.ToLocalChecked());
}
void Init(v8::Local<v8::Object> exports)
{
    v8::Local<v8::Context> context = exports->CreationContext();
    exports->Set(context,
                 Nan::New("mine").ToLocalChecked(),
                 Nan::New<v8::FunctionTemplate>(Mine)
                     ->GetFunction(context)
                     .ToLocalChecked());
}

NODE_MODULE(addon, Init)

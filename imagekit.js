import ImageKit from "imagekit-javascript";

const imagekit = new ImageKit({
  publicKey: "public_z44cHiHVzvCvDlKJNtfsCiHg+MY=", // از داشبورد ImageKit
  urlEndpoint: "https://ik.imagekit.io/vviiiq5g29",
  authenticationEndpoint: "https://wtycgduarwpgnxxvwtgz.supabase.co/functions/v1/imagekit-auth",
});

export default imagekit;

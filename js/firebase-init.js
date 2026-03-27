// Firebase configuration
// Replace every REPLACE_* value with your actual Firebase project credentials
// Project console: https://console.firebase.google.com/
const firebaseConfig = {
    apiKey: "AIzaSyBWogAby54M1QuZ51X_YUnQ19X49rxJHUo",
    authDomain: "indie-games-fdf3b.firebaseapp.com",
    projectId: "indie-games-fdf3b",
    storageBucket: "indie-games-fdf3b.firebasestorage.app",
    messagingSenderId: "275081049912",
    appId: "1:275081049912:web:4dac91f8c3b979643533cd"
};

firebase.initializeApp(firebaseConfig);

const auth = firebase.auth();
const db   = firebase.database();

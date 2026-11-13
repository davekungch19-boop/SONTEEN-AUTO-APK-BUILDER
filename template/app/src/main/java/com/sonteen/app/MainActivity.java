package com.sonteen.app;
import android.app.Activity;
import android.os.Bundle;
import android.widget.TextView;
import android.view.Gravity;
public class MainActivity extends Activity {
    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        TextView view = new TextView(this);
        view.setText("SONTEEN Android App");
        view.setTextSize(22);
        view.setGravity(Gravity.CENTER);
        setContentView(view);
    }
}
